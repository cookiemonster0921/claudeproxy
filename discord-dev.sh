#!/usr/bin/env bash
# discord-dev.sh — Local Discord bot development with ngrok tunnel
#
# Usage:
#   ./discord-dev.sh          # start full dev environment
#   ./discord-dev.sh migrate  # only run local D1 migrations
#   ./discord-dev.sh stop     # kill wrangler + ngrok
#
# What it does:
#   1. Runs all D1 migrations against the local wrangler dev DB
#   2. Starts wrangler dev on port 8787 (with --log-level=debug for full output)
#   3. Starts ngrok tunnel → https://<id>.ngrok-free.app
#   4. Polls ngrok API for the public URL, then prints it
#   5. Shows colorized request/response log from wrangler in the terminal
#   6. Opens ngrok web inspector (http://localhost:4040) in your browser
#
# Set DISCORD_INTERACTIONS_ENDPOINT in your Discord app to the printed URL.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
WORKER_PORT=8787
NGROK_PORT=4040
WRANGLER_PID_FILE="/tmp/discord-dev-wrangler.pid"
NGROK_PID_FILE="/tmp/discord-dev-ngrok.pid"
LOG_DIR="/tmp/discord-dev-logs"
WRANGLER_LOG="$LOG_DIR/wrangler.log"
NGROK_LOG="$LOG_DIR/ngrok.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo -e "${CYAN}[discord-dev]${RESET} $*"; }
success() { echo -e "${GREEN}[discord-dev]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[discord-dev]${RESET} $*"; }
error()   { echo -e "${RED}[discord-dev]${RESET} $*" >&2; }

die() { error "$*"; exit 1; }

require() {
  command -v "$1" &>/dev/null || die "'$1' not found. Install it first."
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

cmd_stop() {
  info "Stopping wrangler and ngrok..."
  [[ -f "$WRANGLER_PID_FILE" ]] && kill "$(cat "$WRANGLER_PID_FILE")" 2>/dev/null && rm -f "$WRANGLER_PID_FILE" && success "wrangler stopped"
  [[ -f "$NGROK_PID_FILE"   ]] && kill "$(cat "$NGROK_PID_FILE")"   2>/dev/null && rm -f "$NGROK_PID_FILE"   && success "ngrok stopped"
  # Belt-and-suspenders
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f "ngrok http"   2>/dev/null || true
  info "Done."
}

cmd_migrate() {
  info "Running all local D1 migrations..."
  local migrations=(
    migrations/0001_create_analytics.sql
    migrations/0002_add_snapshots.sql
    migrations/0003_discord.sql
    migrations/0004_discord_v2.sql
    migrations/0005_token_accounting.sql
    migrations/0006_cloud_sessions.sql
    migrations/0007_nullable_content.sql
  )
  for f in "${migrations[@]}"; do
    if [[ ! -f "$f" ]]; then
      warn "  skipping $f (not found)"
      continue
    fi
    printf "${DIM}  wrangler d1 execute ... --local --file=%s${RESET} " "$f"
    if npx wrangler d1 execute claude_proxy_analytics --local --file="$f" 2>&1 \
        | grep -qE "duplicate column|already exists" ; then
      echo -e "${DIM}(already applied)${RESET}"
    else
      echo -e "${GREEN}✓${RESET}"
    fi
  done
  success "All local migrations done."
}

wait_for_ngrok_url() {
  local attempts=0
  while (( attempts < 30 )); do
    local url
    url=$(curl -s http://localhost:${NGROK_PORT}/api/tunnels 2>/dev/null \
          | grep -o '"public_url":"https://[^"]*"' \
          | head -1 \
          | sed 's/"public_url":"//;s/"//g') 2>/dev/null || true
    if [[ -n "$url" ]]; then
      echo "$url"
      return 0
    fi
    sleep 1
    (( attempts++ ))
  done
  return 1
}

# Pretty-print wrangler logs with colour coding
print_wrangler_logs() {
  # Tail -f the wrangler log and highlight key events
  tail -f "$WRANGLER_LOG" 2>/dev/null | while IFS= read -r line; do
    if   [[ "$line" =~ "POST /discord/interactions" ]]; then
      echo -e "${GREEN}▶ ${RESET}${BOLD}${line}${RESET}"
    elif [[ "$line" =~ "GET " || "$line" =~ "POST " ]]; then
      echo -e "${CYAN}▶ ${RESET}${line}"
    elif [[ "$line" =~ "[discord]" ]]; then
      echo -e "${YELLOW}🤖 ${RESET}${line}"
    elif [[ "$line" =~ "Error\|error\|ERROR\|✘\|failed" ]]; then
      echo -e "${RED}✘ ${RESET}${line}"
    elif [[ "$line" =~ "console.log\|console.error\|console.warn" ]]; then
      echo -e "${DIM}  ${line}${RESET}"
    else
      echo -e "${DIM}${line}${RESET}"
    fi
  done
}

cmd_start() {
  require ngrok
  require npx

  # Kill any leftovers from previous run
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f "ngrok http"   2>/dev/null || true
  sleep 1

  mkdir -p "$LOG_DIR"
  > "$WRANGLER_LOG"
  > "$NGROK_LOG"

  # 1. Local migrations
  cmd_migrate

  # 2. Start wrangler dev
  info "Starting wrangler dev on port ${WORKER_PORT}..."
  npx wrangler dev \
      --port "$WORKER_PORT" \
      --log-level debug \
      --local \
      --persist-to .wrangler/state \
      >> "$WRANGLER_LOG" 2>&1 &
  echo $! > "$WRANGLER_PID_FILE"

  # Wait for wrangler to be ready
  local wrangler_attempts=0
  printf "${DIM}  waiting for wrangler"
  while (( wrangler_attempts < 20 )); do
    if curl -s "http://localhost:${WORKER_PORT}/health" &>/dev/null; then
      break
    fi
    # Also accept if worker is up even without /health
    if grep -q "Ready on" "$WRANGLER_LOG" 2>/dev/null; then
      break
    fi
    printf "."
    sleep 1
    (( wrangler_attempts++ ))
  done
  echo -e "${RESET}"
  success "wrangler dev running  (pid $(cat $WRANGLER_PID_FILE))"

  # 3. Start ngrok
  info "Starting ngrok tunnel → localhost:${WORKER_PORT}..."
  ngrok http "$WORKER_PORT" \
    --log=stdout \
    --log-format=json \
    > "$NGROK_LOG" 2>&1 &
  echo $! > "$NGROK_PID_FILE"

  # 4. Get public URL
  printf "${DIM}  waiting for ngrok"
  local PUBLIC_URL
  PUBLIC_URL=$(wait_for_ngrok_url) || die "ngrok didn't start — check $NGROK_LOG"
  echo -e "${RESET}"
  success "ngrok tunnel active   (pid $(cat $NGROK_PID_FILE))"

  # 5. Print instructions
  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}  Discord interactions endpoint:${RESET}"
  echo -e ""
  echo -e "    ${GREEN}${BOLD}${PUBLIC_URL}/discord/interactions${RESET}"
  echo -e ""
  echo -e "  Paste ↑ into Discord Developer Portal → General Information"
  echo -e "  → Interactions Endpoint URL  →  Save Changes"
  echo -e ""
  echo -e "${BOLD}  Request inspector (full req/res bodies):${RESET}"
  echo -e ""
  echo -e "    ${CYAN}http://localhost:${NGROK_PORT}${RESET}  (opens in browser in 2s)"
  echo -e ""
  echo -e "${BOLD}  Log files:${RESET}"
  echo -e "    wrangler: ${DIM}${WRANGLER_LOG}${RESET}"
  echo -e "    ngrok:    ${DIM}${NGROK_LOG}${RESET}"
  echo -e ""
  echo -e "  Press ${BOLD}Ctrl-C${RESET} to stop everything."
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""

  # Open ngrok inspector
  sleep 2
  open "http://localhost:${NGROK_PORT}" 2>/dev/null || true

  # 6. Tail wrangler logs with coloring
  info "Tailing wrangler logs (Ctrl-C to stop)..."
  echo ""

  # Trap Ctrl-C to clean up
  trap 'echo ""; info "Shutting down..."; cmd_stop; exit 0' INT TERM

  print_wrangler_logs
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
cd "$(dirname "$0")"  # always run from repo root

case "${1:-start}" in
  start)   cmd_start   ;;
  stop)    cmd_stop    ;;
  migrate) cmd_migrate ;;
  *)
    echo "Usage: $0 [start|stop|migrate]"
    exit 1
    ;;
esac
