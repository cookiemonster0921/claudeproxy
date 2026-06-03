#!/usr/bin/env bash
# ops-discord-dev.sh - local operations-bot endpoint with a stable ngrok
# process across Wrangler hot reloads.
#
# Usage:
#   ./ops-discord-dev.sh
#   ./ops-discord-dev.sh stop
#   ./ops-discord-dev.sh status

set -euo pipefail

WORKER_PORT="${OPS_WORKER_PORT:-8788}"
NGROK_PORT=4040
WRANGLER_PID_FILE="/tmp/ops-discord-dev-wrangler.pid"
NGROK_PID_FILE="/tmp/ops-discord-dev-ngrok.pid"
LOG_DIR="/tmp/ops-discord-dev-logs"
WRANGLER_LOG="$LOG_DIR/wrangler.log"
NGROK_LOG="$LOG_DIR/ngrok.log"

info() { printf '[ops-discord-dev] %s\n' "$*"; }
die() { printf '[ops-discord-dev] ERROR: %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required."
}

stop_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    kill "$(cat "$file")" 2>/dev/null || true
    rm -f "$file"
  fi
}

cmd_stop() {
  stop_pid_file "$WRANGLER_PID_FILE"
  stop_pid_file "$NGROK_PID_FILE"
  info "Stopped Wrangler and ngrok."
}

wait_for_url() {
  local attempts=0
  while (( attempts < 30 )); do
    local url
    url="$(curl -fsS "http://127.0.0.1:${NGROK_PORT}/api/tunnels" 2>/dev/null |
      grep -o '"public_url":"https://[^"]*"' |
      head -1 |
      sed 's/"public_url":"//;s/"//g' || true)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return
    fi
    sleep 1
    (( attempts++ ))
  done
  return 1
}

cmd_status() {
  if [[ -f "$WRANGLER_PID_FILE" ]] && kill -0 "$(cat "$WRANGLER_PID_FILE")" 2>/dev/null; then
    info "Wrangler is running on http://127.0.0.1:${WORKER_PORT}"
  else
    info "Wrangler is not running."
  fi
  if [[ -f "$NGROK_PID_FILE" ]] && kill -0 "$(cat "$NGROK_PID_FILE")" 2>/dev/null; then
    local url
    url="$(wait_for_url || true)"
    [[ -n "$url" ]] && info "Discord endpoint: ${url}/discord/ops/interactions"
  else
    info "ngrok is not running."
  fi
}

cmd_start() {
  require curl
  require ngrok
  require npx

  cmd_stop
  mkdir -p "$LOG_DIR"
  : > "$WRANGLER_LOG"
  : > "$NGROK_LOG"

  info "Starting Wrangler on port $WORKER_PORT"
  npx wrangler dev \
    --port "$WORKER_PORT" \
    --local \
    --persist-to .wrangler/state \
    >> "$WRANGLER_LOG" 2>&1 &
  echo $! > "$WRANGLER_PID_FILE"

  local attempts=0
  until curl -fsS "http://127.0.0.1:${WORKER_PORT}/health" >/dev/null 2>&1; do
    (( attempts++ ))
    (( attempts < 30 )) || die "Wrangler did not start. Check $WRANGLER_LOG"
    sleep 1
  done

  info "Starting ngrok on port $NGROK_PORT"
  ngrok http "$WORKER_PORT" \
    --log=stdout \
    --log-format=json \
    > "$NGROK_LOG" 2>&1 &
  echo $! > "$NGROK_PID_FILE"

  local public_url
  public_url="$(wait_for_url)" || die "ngrok did not start. Check $NGROK_LOG"

  printf '\nDiscord Developer Portal -> General Information -> Interactions Endpoint URL:\n\n'
  printf '  %s/discord/ops/interactions\n\n' "$public_url"
  printf 'ngrok inspector: http://127.0.0.1:%s\n' "$NGROK_PORT"
  printf 'Wrangler log:    %s\n' "$WRANGLER_LOG"
  printf 'ngrok log:       %s\n\n' "$NGROK_LOG"
  info "Wrangler hot reloads without restarting ngrok. Press Ctrl-C to stop both."

  trap 'printf "\\n"; cmd_stop; exit 0' INT TERM
  tail -f "$WRANGLER_LOG"
}

cd "$(dirname "$0")"

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) die "Usage: $0 [start|stop|status]" ;;
esac
