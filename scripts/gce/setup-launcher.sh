#!/usr/bin/env bash
# setup-launcher.sh — Install and configure discord_session_launcher.py on the GCE VM.
#
# Run this once after provision-vm.sh, and again whenever you want to push
# local code changes to the VM.
#
# What it does:
#   1. rsyncs the repo root (excluding node_modules, .git, secrets) to the VM
#   2. Writes .dev.vars on the VM from your local one (filtered to safe keys)
#   3. Installs claude-launcher.service (systemd) and starts it
#
# Usage:
#   ./scripts/gce/setup-launcher.sh           # full setup (rsync + service)
#   ./scripts/gce/setup-launcher.sh --update  # re-rsync + restart service only
#   ./scripts/gce/setup-launcher.sh --logs    # tail live service logs
#   ./scripts/gce/setup-launcher.sh --status  # show daemon status
#   ./scripts/gce/setup-launcher.sh --vm-name my-vm

set -euo pipefail

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[gce]${RESET} $*"; }
success() { echo -e "${GREEN}[gce]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[gce]${RESET} $*"; }
die()     { echo -e "${RED}[gce] ERROR:${RESET} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="$SCRIPT_DIR/.state"
DEV_VARS="$REPO_ROOT/.dev.vars"

VM_NAME="claude-discord-vm"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
[[ ! -f "$SSH_KEY" ]] && SSH_KEY="$HOME/.ssh/id_rsa"
MODE="setup"   # setup | update | logs | status

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --vm-name) VM_NAME="$2"; shift 2 ;;
        --ssh-key) SSH_KEY="$2"; shift 2 ;;
        --update)  MODE="update"; shift  ;;
        --logs)    MODE="logs";   shift  ;;
        --status)  MODE="status"; shift  ;;
        --help|-h) grep '^#' "$0" | head -30 | sed 's/^# \?//'; exit 0 ;;
        *) die "Unknown flag: $1. Run with --help." ;;
    esac
done

STATE_FILE="$STATE_DIR/${VM_NAME}.env"
[[ -f "$STATE_FILE" ]] || die "No state for '$VM_NAME'. Run provision-vm.sh first."
# shellcheck source=/dev/null
source "$STATE_FILE"
# Exports: GCE_INSTANCE_NAME, GCE_PROJECT, GCE_ZONE, GCE_PUBLIC_IP, SSH_USER

ssh_run() {
    ssh -i "$SSH_KEY" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=15 \
        -o BatchMode=yes \
        "$SSH_USER@$GCE_PUBLIC_IP" "$@"
}

# ── LOGS ──────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "logs" ]]; then
    info "Streaming launcher logs from $VM_NAME ($GCE_PUBLIC_IP)..."
    exec ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no \
        "$SSH_USER@$GCE_PUBLIC_IP" \
        "journalctl -u claude-launcher -f --no-pager"
fi

# ── STATUS ────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "status" ]]; then
    info "Launcher status on $VM_NAME ($GCE_PUBLIC_IP):"
    echo ""
    ssh_run "systemctl status claude-launcher --no-pager 2>&1 || true"
    echo ""
    info "Active tmux sessions:"
    ssh_run "tmux ls 2>/dev/null | grep cproxy_ || echo '  (none)'"
    echo ""
    exit 0
fi

# ── RSYNC ─────────────────────────────────────────────────────────────────────
do_rsync() {
    info "Syncing repo to $SSH_USER@$GCE_PUBLIC_IP:~/claude-proxy/ ..."
    rsync -az --delete \
        --exclude='.git/' \
        --exclude='node_modules/' \
        --exclude='.dev.vars' \
        --exclude='scripts/oracle/.state/' \
        --exclude='scripts/gce/.state/' \
        --exclude='*.log' \
        -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
        "$REPO_ROOT/" \
        "$SSH_USER@$GCE_PUBLIC_IP:~/claude-proxy/"
    success "Repo sync complete."
}

do_sync_claude_settings() {
    info "Syncing local Claude settings (skills, plugins, commands, CLAUDE.md) ..."
    bash "$REPO_ROOT/scripts/sync-claude-settings.sh" \
        "$SSH_USER" "$GCE_PUBLIC_IP" "$SSH_KEY"
}

# ── WRITE .dev.vars ON VM ─────────────────────────────────────────────────────
do_write_devvars() {
    [[ -f "$DEV_VARS" ]] || die ".dev.vars not found at $REPO_ROOT/.dev.vars"

    # Read specific values from local .dev.vars
    _read_var() {
        grep -E "^${1}=" "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
    }

    local WORKER_URL PROXY_TOKEN ANTHROPIC_API_KEY DISCORD_BOT_TOKEN
    WORKER_URL="$(_read_var WORKER_URL)"
    PROXY_TOKEN="$(_read_var PROXY_TOKEN)"
    ANTHROPIC_API_KEY="$(_read_var ANTHROPIC_API_KEY)"
    DISCORD_BOT_TOKEN="$(_read_var DISCORD_BOT_TOKEN)"
    [[ -z "$ANTHROPIC_API_KEY" ]] && ANTHROPIC_API_KEY="$PROXY_TOKEN"

    [[ -n "$WORKER_URL"        ]] || die "WORKER_URL not set in .dev.vars"
    [[ -n "$PROXY_TOKEN"       ]] || die "PROXY_TOKEN not set in .dev.vars"
    [[ -n "$DISCORD_BOT_TOKEN" ]] || die "DISCORD_BOT_TOKEN not set in .dev.vars"

    # Derive WebSocket URL from WORKER_URL
    local WS_URL
    WS_URL="$(echo "$WORKER_URL" | sed 's|https://|wss://|; s|http://|ws://|')"/launcher-ws

    info "Writing .dev.vars on VM..."
    ssh_run "bash -s" << EOF
cat > ~/claude-proxy/.dev.vars << 'DEVVARS'
WORKER_URL=${WORKER_URL}
PROXY_TOKEN=${PROXY_TOKEN}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
ANTHROPIC_AUTH_TOKEN=${PROXY_TOKEN}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
LAUNCHER_WS_URL=${WS_URL}
LAUNCHER_TARGET=computeengine
LAUNCHER_BACKGROUND=1
DEVVARS
chmod 600 ~/claude-proxy/.dev.vars
echo "[setup] .dev.vars written."
EOF
    success ".dev.vars written on VM."
}

# ── INSTALL SYSTEMD SERVICE ───────────────────────────────────────────────────
do_install_service() {
    info "Installing claude-launcher systemd service..."

    # Read values to embed in the service (env block inside the unit file)
    _read_var() {
        grep -E "^${1}=" "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
    }
    local WORKER_URL PROXY_TOKEN ANTHROPIC_API_KEY DISCORD_BOT_TOKEN
    WORKER_URL="$(_read_var WORKER_URL)"
    PROXY_TOKEN="$(_read_var PROXY_TOKEN)"
    ANTHROPIC_API_KEY="$(_read_var ANTHROPIC_API_KEY)"
    DISCORD_BOT_TOKEN="$(_read_var DISCORD_BOT_TOKEN)"
    [[ -z "$ANTHROPIC_API_KEY" ]] && ANTHROPIC_API_KEY="$PROXY_TOKEN"
    local WS_URL
    WS_URL="$(echo "$WORKER_URL" | sed 's|https://|wss://|; s|http://|ws://|')"/launcher-ws

    ssh_run "bash -s" << EOF
sudo tee /etc/systemd/system/claude-launcher.service > /dev/null << 'UNIT'
[Unit]
Description=Claude Code Discord Session Launcher (computeengine)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SSH_USER}
WorkingDirectory=/home/${SSH_USER}/claude-proxy
ExecStart=/usr/bin/python3 /home/${SSH_USER}/claude-proxy/discord_session_launcher.py
Restart=always
RestartSec=5
Environment="LAUNCHER_TARGET=computeengine"
Environment="LAUNCHER_BACKGROUND=1"
Environment="LAUNCHER_WS_URL=${WS_URL}"
Environment="PROXY_TOKEN=${PROXY_TOKEN}"
Environment="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
Environment="ANTHROPIC_AUTH_TOKEN=${PROXY_TOKEN}"
Environment="DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}"

[Install]
WantedBy=default.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now claude-launcher
echo "[setup] Service installed and started."
EOF
    success "claude-launcher service installed."
}

# ── UPDATE (rsync + settings sync + restart only) ────────────────────────────
if [[ "$MODE" == "update" ]]; then
    do_rsync
    do_sync_claude_settings
    info "Restarting service..."
    ssh_run "sudo systemctl restart claude-launcher"
    sleep 2
    ssh_run "systemctl is-active claude-launcher && echo '  ✅ Service is running.' || echo '  ❌ Service failed to start.'"
    exit 0
fi

# ── FULL SETUP ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Setting up launcher daemon on $VM_NAME ($GCE_PUBLIC_IP)${RESET}"
echo ""

do_rsync
do_write_devvars
do_install_service
do_sync_claude_settings

# ── Bootstrap: trust the working directory + install the Discord plugin ───────
# Running `claude --print` once in non-interactive mode does two things:
#   1. Marks ~/claude-proxy as a trusted directory (so future sessions skip the
#      "Do you trust this folder?" dialog entirely)
#   2. Triggers Discord plugin download/installation for the VM's architecture
#      (the plugin cache is platform-specific; we can't rsync it from macOS)
# We pass --print so it exits immediately without waiting for user input.
# ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL come from .dev.vars on the VM.
info "Bootstrapping Claude: trusting workspace + installing Discord plugin..."
_read_var() {
    grep -E "^${1}=" "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}
WORKER_URL="$(_read_var WORKER_URL)"
PROXY_TOKEN="$(_read_var PROXY_TOKEN)"

ssh_run "bash -s" << EOF
set -e
cd ~/claude-proxy
export ANTHROPIC_BASE_URL="${WORKER_URL}"
export ANTHROPIC_AUTH_TOKEN="${PROXY_TOKEN}"
export ANTHROPIC_API_KEY="${PROXY_TOKEN}"
# --print runs non-interactively: skips trust dialog, installs plugins, exits.
# --channels ensures the Discord plugin is downloaded for this VM's architecture.
echo "[bootstrap] Running claude --print to trust directory and install plugins..."
timeout 60 claude --channels "plugin:discord@claude-plugins-official" \
    --print "ping" 2>&1 | head -5 || true
echo "[bootstrap] Done."
EOF
success "Workspace trusted, Discord plugin installed."

# Verify
sleep 3
echo ""
info "Verifying service..."
ssh_run "systemctl is-active claude-launcher && echo '  ✅ Launcher daemon is running.' || echo '  ❌ Service not running — check: journalctl -u claude-launcher -n 30'"

echo ""
echo -e "${BOLD}  Setup complete.${RESET}"
echo ""
echo "  The daemon will now receive /computeengine launch frames from Discord."
echo "  Sessions run as detached tmux windows on the VM."
echo ""
echo "  Useful commands:"
echo "    Tail logs:          ./scripts/gce/setup-launcher.sh --logs"
echo "    Service status:     ./scripts/gce/setup-launcher.sh --status"
echo "    Push code changes:  ./scripts/gce/setup-launcher.sh --update"
echo "    SSH into VM:        ./scripts/gce/provision-vm.sh --connect"
echo ""
echo "  On the VM:"
echo "    List sessions:      tmux ls"
echo "    Attach to session:  tmux attach -t cproxy_<id>"
echo "    Session logs:       tail -f ~/.claude/discord-sessions/logs/<id>.log"
echo ""
echo "  One-time auth (first time only — run on the VM):"
echo "    ./scripts/gce/provision-vm.sh --connect"
echo "    claude   # log in with your Anthropic account, then Ctrl+C"
echo ""
