#!/usr/bin/env bash
# launch-cloud-shell.sh — Open your GCP Cloud Shell with Claude Code pre-configured
#                         and routed through the deployed claude-proxy Worker.
#
# Cloud Shell is a free, browser-accessible VM (Debian, 5 GB persistent home).
# This script connects via `gcloud cloud-shell ssh`, installs Claude Code on
# first run (persisted to ~/), then drops straight into `claude`.
#
# Requirements:
#   gcloud CLI authenticated:  gcloud auth login
#   Cloud Shell API enabled:  done automatically on first use
#
# Usage:
#   ./scripts/launch-cloud-shell.sh
#   ./scripts/launch-cloud-shell.sh --worker-url https://... --proxy-token sk-...
#
# Credentials are read from .dev.vars if not passed as flags.

set -euo pipefail

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[cloud-shell]${RESET} $*"; }
success() { echo -e "${GREEN}[cloud-shell]${RESET} $*"; }
die()     { echo -e "${RED}[cloud-shell] ERROR:${RESET} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_VARS="$REPO_ROOT/.dev.vars"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --worker-url)  WORKER_URL="$2";  shift 2 ;;
        --proxy-token) PROXY_TOKEN="$2"; shift 2 ;;
        --help|-h)     grep '^#' "$0" | head -20 | sed 's/^# \?//'; exit 0 ;;
        *) die "Unknown flag: $1" ;;
    esac
done

# ── Read credentials from .dev.vars ──────────────────────────────────────────
if [[ -f "$DEV_VARS" ]]; then
    WORKER_URL="${WORKER_URL:-$(grep -E '^WORKER_URL=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    PROXY_TOKEN="${PROXY_TOKEN:-$(grep -E '^PROXY_TOKEN=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
fi

[[ -z "${WORKER_URL:-}" ]] && die "WORKER_URL not set. Add it to .dev.vars or pass --worker-url"
WORKER_URL="${WORKER_URL%/}"
PROXY_TOKEN="${PROXY_TOKEN:-dev-token}"

command -v gcloud &>/dev/null || die "gcloud CLI not installed. See https://cloud.google.com/sdk/docs/install"

echo ""
echo -e "${BOLD}  Launching Cloud Shell → claude-proxy${RESET}"
echo "  Worker URL : $WORKER_URL"
echo "  Token      : ${PROXY_TOKEN:0:4}$(printf '%0.s*' {1..8})"
echo ""
info "Connecting (this may take 30–60 s if Cloud Shell is cold-starting)..."
echo ""

# ── Build the remote setup + launch command ───────────────────────────────────
# This runs inside Cloud Shell via SSH.
# It is written to a single string with careful quoting so that:
#   - Variables are expanded HERE (on your local machine) where we have the values
#   - The resulting string is sent verbatim to the remote shell
#
# Steps on the remote side:
#   1. Add ~/.local/bin to PATH (where the installer puts `claude`)
#   2. Install Claude Code if it isn't already there (persists across sessions)
#   3. Export proxy env vars (same set as `cproxy on prod`)
#   4. Unset any Vertex/Bedrock vars that could bypass the proxy
#   5. exec `claude` so it becomes the session process (clean exit on Ctrl-C)

REMOTE_CMD="
set -e
export PATH=\"\$HOME/.local/bin:\$PATH\"

if ! command -v claude &>/dev/null; then
    echo '[setup] Claude Code not found — installing...'
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH=\"\$HOME/.local/bin:\$PATH\"
    echo '[setup] Install complete.'
else
    echo '[setup] Claude Code already installed: '\$(claude --version 2>/dev/null || echo unknown)
fi

# Proxy env vars — mirrors cproxy on prod
export ANTHROPIC_BASE_URL='${WORKER_URL}'
export ANTHROPIC_AUTH_TOKEN='${PROXY_TOKEN}'
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='1'
export CLAUDE_CODE_SKIP_TELEMETRY='1'
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'

# Unset bypass vars so Claude Code cannot route around the Worker
unset CLAUDE_CODE_USE_VERTEX ANTHROPIC_VERTEX_PROJECT_ID ANTHROPIC_VERTEX_BASE_URL \
      CLOUD_ML_REGION CLAUDE_CODE_USE_BEDROCK ANTHROPIC_BEDROCK_BASE_URL \
      CLAUDE_CODE_USE_ANTHROPIC_AWS ANTHROPIC_AWS_BASE_URL 2>/dev/null || true

echo ''
echo '  ╔══════════════════════════════════════════════════════════════════╗'
echo '  ║  Backend: PRODUCTION (claude-proxy Cloudflare Worker)           ║'
echo '  ║  Type /help to see available commands                           ║'
echo '  ╚══════════════════════════════════════════════════════════════════╝'
echo ''

exec claude
"

# ── Connect via gcloud cloud-shell ssh ───────────────────────────────────────
# --ssh-flag="-t"  forces TTY allocation so Claude Code's interactive UI works
# --               separates gcloud flags from the remote command
# bash -il         -i = interactive, -l = login shell (sources .profile/.bashrc)
#                  needed so PATH and locale are fully set up in Cloud Shell
gcloud cloud-shell ssh \
    --ssh-flag="-t" \
    -- bash -il -c "$REMOTE_CMD"
