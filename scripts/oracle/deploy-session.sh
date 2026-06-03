#!/usr/bin/env bash
# deploy-session.sh — Build and manage Discord Claude sessions on an Oracle Cloud VM.
#
# ── Build pipeline ────────────────────────────────────────────────────────────
# docker/discord-plugin/server.ts is the single source of truth.
# The Dockerfile (docker/Dockerfile.claude-discord) and build command are
# UNCHANGED — the same `docker build -f docker/Dockerfile.claude-discord .`
# runs on the Oracle VM. Local edits are packaged into each rebuild by
# rsyncing the docker/ directory to the VM before building.
#
# Workflow:
#   1. Edit docker/discord-plugin/server.ts (or any file under docker/)
#   2. ./scripts/oracle/deploy-session.sh build   ← rsync + docker build on VM
#   3. ./scripts/oracle/deploy-session.sh start --channel-id X --discord-users Y
#
# Sessions persist across VM reboots via named Docker volumes:
#   discord-state-<channel-id>  →  /root/.claude/  (conversation history, settings)
#   discord-workspace-<channel-id>  →  /workspace/  (files Claude creates)
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#   ./scripts/oracle/deploy-session.sh build
#       Sync local docker/ to the VM and build the claude-discord image there.
#
#   ./scripts/oracle/deploy-session.sh start \
#       --channel-id 1234567890123456789 \
#       --discord-users 111222333,444555666 \
#       [--require-mention]
#       Start a Discord session container for the given channel.
#
#   ./scripts/oracle/deploy-session.sh stop --channel-id 1234567890
#       Stop and remove the session container (volumes are preserved).
#
#   ./scripts/oracle/deploy-session.sh list
#       List all running Discord sessions on the VM.
#
#   ./scripts/oracle/deploy-session.sh logs --channel-id 1234567890 [--follow]
#       Stream logs from a session container.
#
#   ./scripts/oracle/deploy-session.sh ssh
#       Open an interactive SSH session on the VM.
#
#   ./scripts/oracle/deploy-session.sh restart --channel-id 1234567890
#       Stop then start the session (picks up a rebuilt image).

set -euo pipefail

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[oracle]${RESET} $*"; }
success() { echo -e "${GREEN}[oracle]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[oracle]${RESET} $*"; }
die()     { echo -e "${RED}[oracle] ERROR:${RESET} $*" >&2; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────
VM_NAME="claude-discord-vm"
ACTION="${1:-help}"
CHANNEL_ID=""
ALLOWED_USERS=""
REQUIRE_MENTION="false"
IMAGE_NAME="claude-discord"
IMAGE_TAG="latest"
FOLLOW_LOGS=false
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
[[ ! -f "$SSH_KEY" ]] && SSH_KEY="$HOME/.ssh/id_rsa"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="$SCRIPT_DIR/.state"
STATE_FILE="$STATE_DIR/${VM_NAME}.env"
DEV_VARS="$REPO_ROOT/.dev.vars"

shift || true   # consume ACTION from $@

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --vm-name)         VM_NAME="$2";          shift 2 ;;
        --channel-id)      CHANNEL_ID="$2";       shift 2 ;;
        --discord-users)   ALLOWED_USERS="$2";    shift 2 ;;
        --require-mention) REQUIRE_MENTION="true"; shift   ;;
        --image-tag)       IMAGE_TAG="$2";         shift 2 ;;
        --follow|-f)       FOLLOW_LOGS=true;       shift   ;;
        --ssh-key)         SSH_KEY="$2";           shift 2 ;;
        --help|-h)
            grep '^#' "$0" | head -55 | sed 's/^# \?//'
            exit 0
            ;;
        *) die "Unknown flag: $1. Run with --help." ;;
    esac
done

STATE_FILE="$STATE_DIR/${VM_NAME}.env"

# ── Load VM state ─────────────────────────────────────────────────────────────
[[ -f "$STATE_FILE" ]] || die "No state for '$VM_NAME'. Run provision-vm.sh first."
# shellcheck source=/dev/null
source "$STATE_FILE"
# STATE_FILE exports: OCI_PUBLIC_IP, OCI_SHAPE, SSH_USER, OCI_REGION, VM_NAME

# ── Read credentials from .dev.vars ──────────────────────────────────────────
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
WORKER_URL="${WORKER_URL:-}"
PROXY_TOKEN="${PROXY_TOKEN:-dev-token}"

if [[ -f "$DEV_VARS" ]]; then
    DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(grep -E '^DISCORD_BOT_TOKEN=' "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    WORKER_URL="${WORKER_URL:-$(grep -E '^WORKER_URL=' "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    PROXY_TOKEN="${PROXY_TOKEN:-$(grep -E '^PROXY_TOKEN=' "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
fi

# ── SSH helper ────────────────────────────────────────────────────────────────
ssh_run() {
    ssh -i "$SSH_KEY" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=15 \
        -o BatchMode=yes \
        "$SSH_USER@$OCI_PUBLIC_IP" "$@"
}

# ── Session name (deterministic per channel) ──────────────────────────────────
session_name() { echo "discord-session-${1:-unknown}"; }

# ── ACTION: build ─────────────────────────────────────────────────────────────
# Syncs local docker/ to the Oracle VM then runs docker build there.
# The Dockerfile is unchanged — identical command to a local build.
do_build() {
    echo ""
    echo -e "${BOLD}  Build pipeline: local → Oracle VM → docker build${RESET}"
    echo "  VM   : $VM_NAME ($OCI_PUBLIC_IP)"
    echo "  Image: ${IMAGE_NAME}:${IMAGE_TAG}"
    echo ""

    # 1. Sync plugin: docker/ → local Claude plugin cache (source of truth)
    info "Syncing plugin (docker/ → local cache)..."
    "$REPO_ROOT/scripts/sync-discord-plugin.sh"

    # 2. Ensure remote directory exists
    ssh_run "mkdir -p ~/claude-proxy/docker ~/claude-proxy/scripts"

    # 3. rsync docker/ directory to VM — this is the entire build context
    #    that changes between rebuilds. The Dockerfile lives here too.
    info "Rsyncing docker/ to VM..."
    rsync -az --delete \
        -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
        "$REPO_ROOT/docker/" \
        "$SSH_USER@$OCI_PUBLIC_IP:~/claude-proxy/docker/"

    # 4. rsync scripts/ (entrypoint references sync-discord-plugin.sh)
    info "Rsyncing scripts/ to VM..."
    rsync -az --delete \
        -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
        "$REPO_ROOT/scripts/" \
        "$SSH_USER@$OCI_PUBLIC_IP:~/claude-proxy/scripts/"

    # 5. Build image on VM using the UNCHANGED Dockerfile and build command.
    #    Building on the VM (not cross-compiling) ensures the image matches
    #    the VM's native CPU architecture (arm64 or amd64) automatically.
    info "Building ${IMAGE_NAME}:${IMAGE_TAG} on VM..."
    ssh_run "docker build \
        --file ~/claude-proxy/docker/Dockerfile.claude-discord \
        --tag ${IMAGE_NAME}:${IMAGE_TAG} \
        ~/claude-proxy"

    success "Image built: ${IMAGE_NAME}:${IMAGE_TAG} on $OCI_PUBLIC_IP"
    echo ""
    echo "  Start a session:"
    echo "    $0 start --channel-id CHANNEL_ID --discord-users USER_ID"
    echo ""
}

# ── ACTION: start ─────────────────────────────────────────────────────────────
do_start() {
    [[ -z "$CHANNEL_ID" ]]        && die "--channel-id is required"
    [[ -z "$DISCORD_BOT_TOKEN" ]] && die "DISCORD_BOT_TOKEN not set in .dev.vars or env"
    [[ -z "$WORKER_URL" ]]        && die "WORKER_URL not set in .dev.vars or env"

    WORKER_URL="${WORKER_URL%/}"
    local name
    name=$(session_name "$CHANNEL_ID")

    # Stop existing session for this channel if running
    local existing
    existing=$(ssh_run "docker inspect $name 2>/dev/null && echo exists || true")
    if [[ "$existing" == "exists" ]]; then
        warn "Session '$name' already running — stopping it first."
        ssh_run "docker stop $name 2>/dev/null; docker rm $name 2>/dev/null" || true
    fi

    info "Starting session for channel ${CHANNEL_ID} on $OCI_PUBLIC_IP..."

    # Named volumes persist across container restarts and VM reboots.
    # discord-state: ~/.claude/ (conversation history, settings, plugin state)
    # discord-workspace: /workspace/ (files Claude creates)
    ssh_run "docker run -d -i \
        --name $name \
        --restart unless-stopped \
        -e DISCORD_BOT_TOKEN='$DISCORD_BOT_TOKEN' \
        -e DISCORD_ALLOWED_CHANNEL='$CHANNEL_ID' \
        -e DISCORD_ALLOWED_USERS='$ALLOWED_USERS' \
        -e DISCORD_REQUIRE_MENTION='$REQUIRE_MENTION' \
        -e WORKER_URL='$WORKER_URL' \
        -e PROXY_TOKEN='$PROXY_TOKEN' \
        -v discord-state-${CHANNEL_ID}:/root/.claude \
        -v discord-workspace-${CHANNEL_ID}:/workspace \
        ${IMAGE_NAME}:${IMAGE_TAG}"

    success "Session started: $name"
    echo ""
    echo "  Logs:    $0 logs --channel-id $CHANNEL_ID --follow"
    echo "  Stop:    $0 stop --channel-id $CHANNEL_ID"
    echo "  Restart: $0 restart --channel-id $CHANNEL_ID"
    echo ""
}

# ── ACTION: stop ──────────────────────────────────────────────────────────────
do_stop() {
    [[ -z "$CHANNEL_ID" ]] && die "--channel-id is required"
    local name
    name=$(session_name "$CHANNEL_ID")

    info "Stopping session '$name'..."
    ssh_run "docker stop $name && docker rm $name" && \
        success "Session stopped. Volumes (state, workspace) are preserved." || \
        warn "Session '$name' was not running."
}

# ── ACTION: restart ───────────────────────────────────────────────────────────
do_restart() {
    [[ -z "$CHANNEL_ID" ]] && die "--channel-id is required"
    do_stop
    do_start
}

# ── ACTION: list ──────────────────────────────────────────────────────────────
do_list() {
    info "Discord sessions on $VM_NAME ($OCI_PUBLIC_IP):"
    echo ""
    ssh_run "docker ps \
        --filter name=discord-session- \
        --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}\t{{.Image}}'" || \
        echo "  (no sessions running or Docker not reachable)"
    echo ""
}

# ── ACTION: logs ──────────────────────────────────────────────────────────────
do_logs() {
    [[ -z "$CHANNEL_ID" ]] && die "--channel-id is required"
    local name
    name=$(session_name "$CHANNEL_ID")
    local follow_flag=""
    [[ "$FOLLOW_LOGS" == true ]] && follow_flag="--follow"

    info "Logs for $name ($OCI_PUBLIC_IP):"
    echo ""
    # shellcheck disable=SC2029
    ssh_run "docker logs $follow_flag $name 2>&1"
}

# ── ACTION: ssh ───────────────────────────────────────────────────────────────
do_ssh() {
    info "Opening SSH session to $VM_NAME ($OCI_PUBLIC_IP)..."
    exec ssh -i "$SSH_KEY" \
        -o StrictHostKeyChecking=no \
        "$SSH_USER@$OCI_PUBLIC_IP"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$ACTION" in
    build)   do_build   ;;
    start)   do_start   ;;
    stop)    do_stop    ;;
    restart) do_restart ;;
    list)    do_list    ;;
    logs)    do_logs    ;;
    ssh)     do_ssh     ;;
    help|--help|-h)
        grep '^#' "$0" | head -55 | sed 's/^# \?//'
        exit 0
        ;;
    *)
        die "Unknown action: $ACTION. Valid: build, start, stop, restart, list, logs, ssh"
        ;;
esac
