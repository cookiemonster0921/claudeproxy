#!/usr/bin/env bash
# setup.sh — Install Modal CLI, create secrets, and deploy the launcher daemon.
#
# ── Prerequisites ─────────────────────────────────────────────────────────────
#   pip install modal        # Modal Python SDK (includes the CLI)
#   modal token new          # authenticate (opens browser)
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#   ./scripts/modal/setup.sh           # create secrets + deploy
#   ./scripts/modal/setup.sh --update  # redeploy (code change)
#   ./scripts/modal/setup.sh --logs    # tail live container logs
#   ./scripts/modal/setup.sh --stop    # stop the deployed app
#   ./scripts/modal/setup.sh --status  # show app and container status

set -euo pipefail

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[modal]${RESET} $*"; }
success() { echo -e "${GREEN}[modal]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[modal]${RESET} $*"; }
die()     { echo -e "${RED}[modal] ERROR:${RESET} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEV_VARS="$REPO_ROOT/.dev.vars"
MODE="deploy"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --update) MODE="deploy";  shift ;;
        --logs)   MODE="logs";    shift ;;
        --stop)   MODE="stop";    shift ;;
        --status) MODE="status";  shift ;;
        --help|-h) grep '^#' "$0" | head -20 | sed 's/^# \?//'; exit 0 ;;
        *) die "Unknown flag: $1" ;;
    esac
done

# ── Prerequisite checks ───────────────────────────────────────────────────────
command -v modal &>/dev/null || die "Modal CLI not installed. Run: pip install modal"
command -v python3 &>/dev/null || die "python3 is required."
[[ -f "$DEV_VARS" ]] || die ".dev.vars not found at $REPO_ROOT/.dev.vars"

APP_NAME="claude-discord-launcher"
SECRET_NAME="claude-launcher-secrets"

# ── LOGS ──────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "logs" ]]; then
    info "Streaming logs for $APP_NAME ..."
    exec modal app logs "$APP_NAME"
fi

# ── STOP ──────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "stop" ]]; then
    info "Stopping $APP_NAME ..."
    modal app stop "$APP_NAME"
    success "App stopped."
    exit 0
fi

# ── STATUS ────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "status" ]]; then
    echo ""
    echo -e "${BOLD}  Modal app: $APP_NAME${RESET}"
    modal app list 2>/dev/null | grep -E "(Name|$APP_NAME)" || echo "  (not found)"
    echo ""
    info "Running containers:"
    modal container list 2>/dev/null | grep "$APP_NAME" || echo "  (none)"
    echo ""
    exit 0
fi

# ── READ CREDENTIALS FROM .dev.vars ──────────────────────────────────────────
_read_var() {
    grep -E "^${1}=" "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

WORKER_URL="$(_read_var WORKER_URL)"
PROXY_TOKEN="$(_read_var PROXY_TOKEN)"
ANTHROPIC_API_KEY="$(_read_var ANTHROPIC_API_KEY)"
[[ -z "$ANTHROPIC_API_KEY" ]] && ANTHROPIC_API_KEY="$PROXY_TOKEN"

[[ -n "$WORKER_URL"  ]] || die "WORKER_URL not set in .dev.vars"
[[ -n "$PROXY_TOKEN" ]] || die "PROXY_TOKEN not set in .dev.vars"

# Derive WebSocket URL
WS_URL="$(echo "$WORKER_URL" | sed 's|https://|wss://|; s|http://|ws://|')"/launcher-ws

# ── CREATE / UPDATE SECRET ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Setting up Modal secret: $SECRET_NAME${RESET}"
echo ""

# modal secret create errors if the secret already exists; use --force to overwrite.
modal secret create "$SECRET_NAME" \
    LAUNCHER_WS_URL="$WS_URL" \
    PROXY_TOKEN="$PROXY_TOKEN" \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    ANTHROPIC_AUTH_TOKEN="$PROXY_TOKEN" \
    LAUNCHER_TARGET=modal \
    LAUNCHER_BACKGROUND=1 \
    CPROXY_SCRIPT=/app/claude-proxy.sh \
    --force 2>/dev/null || \
modal secret create "$SECRET_NAME" \
    LAUNCHER_WS_URL="$WS_URL" \
    PROXY_TOKEN="$PROXY_TOKEN" \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    ANTHROPIC_AUTH_TOKEN="$PROXY_TOKEN" \
    LAUNCHER_TARGET=modal \
    LAUNCHER_BACKGROUND=1 \
    CPROXY_SCRIPT=/app/claude-proxy.sh

success "Secret '$SECRET_NAME' created/updated."

# ── DEPLOY ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Deploying $APP_NAME to Modal${RESET}"
echo "  App file: scripts/modal/modal_launcher.py"
echo "  Secret  : $SECRET_NAME"
echo ""
warn "First deploy builds the Docker image — this takes 3–5 minutes."
warn "Subsequent deploys reuse the cached image and take ~30 seconds."
echo ""

cd "$REPO_ROOT"
modal deploy scripts/modal/modal_launcher.py

echo ""
success "Deployed! The launcher daemon is now running on Modal."
echo ""
echo "  Useful commands:"
echo "    Tail logs:      ./scripts/modal/setup.sh --logs"
echo "    Status:         ./scripts/modal/setup.sh --status"
echo "    Redeploy:       ./scripts/modal/setup.sh --update"
echo "    Stop:           ./scripts/modal/setup.sh --stop"
echo ""
echo "  To test: run /modal in Discord → model picker → user picker → 🚀 Launch."
echo ""
echo "  ⚠️  One-time: authenticate Claude Code inside the container:"
echo "     modal shell scripts/modal/modal_launcher.py::launcher"
echo "     Then inside the shell: claude  (log in with your Anthropic account)"
echo "     Claude credentials will persist in the container's home directory"
echo "     until the container is recycled (up to 24h)."
echo ""
echo "  For production: store your Claude auth token as a Modal secret:"
echo "     modal secret create claude-auth ANTHROPIC_AUTH_TOKEN=\$(cat ~/.claude/.credentials.json)"
echo "     Then add it to the secrets list in modal_launcher.py."
echo ""
