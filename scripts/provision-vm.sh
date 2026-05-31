#!/usr/bin/env bash
# provision-vm.sh — Create a Compute Engine VM, install Claude Code on it,
#                   and drop into an interactive claude session via SSH.
#
# Unlike Cloud Run or Cloud Shell, this gives you a persistent VM you can
# SSH back into any time. Claude Code is installed directly on the VM
# (no Docker), so it behaves exactly like a local session.
#
# The VM is NOT deleted when you disconnect — run with --delete to tear it down.
#
# Usage:
#   ./scripts/provision-vm.sh                          # create + connect
#   ./scripts/provision-vm.sh --connect                # SSH into existing VM
#   ./scripts/provision-vm.sh --delete                 # destroy the VM
#   ./scripts/provision-vm.sh --project P --zone Z     # explicit project/zone
#
# Credentials (WORKER_URL, PROXY_TOKEN) are read from .dev.vars.

set -euo pipefail

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[vm]${RESET} $*"; }
success() { echo -e "${GREEN}[vm]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[vm]${RESET} $*"; }
die()     { echo -e "${RED}[vm] ERROR:${RESET} $*" >&2; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────
GCP_PROJECT="${GCP_PROJECT:-}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-claude-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-small}"   # e2-micro is free tier but slow; e2-small is better
DISK_SIZE="${DISK_SIZE:-20GB}"
IMAGE_FAMILY="debian-12"
IMAGE_PROJECT="debian-cloud"
MODE="create-and-connect"                  # create-and-connect | connect | delete

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_VARS="$REPO_ROOT/.dev.vars"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)      GCP_PROJECT="$2";   shift 2 ;;
        --zone)         GCP_ZONE="$2";      shift 2 ;;
        --vm-name)      VM_NAME="$2";       shift 2 ;;
        --machine-type) MACHINE_TYPE="$2";  shift 2 ;;
        --worker-url)   WORKER_URL="$2";    shift 2 ;;
        --proxy-token)  PROXY_TOKEN="$2";   shift 2 ;;
        --connect)      MODE="connect";     shift   ;;
        --delete)       MODE="delete";      shift   ;;
        --help|-h)      grep '^#' "$0" | head -25 | sed 's/^# \?//'; exit 0 ;;
        *) die "Unknown flag: $1. Run with --help." ;;
    esac
done

# ── Read credentials from .dev.vars ──────────────────────────────────────────
if [[ -f "$DEV_VARS" ]]; then
    WORKER_URL="${WORKER_URL:-$(grep -E '^WORKER_URL=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    PROXY_TOKEN="${PROXY_TOKEN:-$(grep -E '^PROXY_TOKEN=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
fi

PROXY_TOKEN="${PROXY_TOKEN:-dev-token}"

# ── Validate ──────────────────────────────────────────────────────────────────
command -v gcloud &>/dev/null || die "gcloud CLI not installed. See https://cloud.google.com/sdk/docs/install"

if [[ "$MODE" != "delete" ]]; then
    [[ -z "${WORKER_URL:-}" ]] && die "WORKER_URL not set. Add it to .dev.vars or pass --worker-url"
    WORKER_URL="${WORKER_URL%/}"
fi

# Set project if provided
if [[ -n "$GCP_PROJECT" ]]; then
    gcloud config set project "$GCP_PROJECT" --quiet
fi

# ── Helper: check if VM exists ────────────────────────────────────────────────
vm_exists() {
    gcloud compute instances describe "$VM_NAME" --zone="$GCP_ZONE" --quiet &>/dev/null
}

# ── Helper: wait for SSH to become available ──────────────────────────────────
wait_for_ssh() {
    info "Waiting for SSH to become available on $VM_NAME..."
    local attempts=0
    while ! gcloud compute ssh "$VM_NAME" \
            --zone="$GCP_ZONE" \
            --command="echo ready" \
            --ssh-flag="-o ConnectTimeout=5" \
            --ssh-flag="-o StrictHostKeyChecking=no" \
            --quiet 2>/dev/null; do
        attempts=$((attempts + 1))
        if [[ $attempts -ge 30 ]]; then
            die "VM did not become SSH-accessible within 5 minutes."
        fi
        printf "."
        sleep 10
    done
    echo ""
    success "SSH is ready."
}

# ── Helper: install Claude Code on the VM ────────────────────────────────────
# Runs over SSH. Uses a heredoc so the script is sent as a single connection.
install_claude_on_vm() {
    info "Installing Claude Code and dependencies on the VM..."
    gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --quiet -- bash -s << 'INSTALL'
set -e
echo "[vm-setup] Updating packages..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends curl ca-certificates git

echo "[vm-setup] Installing Claude Code..."
curl -fsSL https://claude.ai/install.sh | bash

# Persist PATH so reconnecting sessions find `claude` without extra steps
if ! grep -q 'claude' ~/.bashrc 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

echo "[vm-setup] Claude Code installed: $(~/.local/bin/claude --version 2>/dev/null || echo 'ok')"
INSTALL
}

# ── Helper: write proxy env vars to the VM's ~/.claude-proxy-env ─────────────
# Sourced at session start so every reconnect is automatically configured.
write_proxy_env() {
    info "Writing proxy configuration to VM..."
    # Use printf to expand the local variables before sending
    gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --quiet -- bash -s << ENVFILE
cat > ~/.claude-proxy-env << 'EOF'
# Auto-generated by provision-vm.sh — re-run the script to update these values.
export PATH="\$HOME/.local/bin:\$PATH"
export ANTHROPIC_BASE_URL="${WORKER_URL}"
export ANTHROPIC_AUTH_TOKEN="${PROXY_TOKEN}"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
export CLAUDE_CODE_SKIP_TELEMETRY="1"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"
unset CLAUDE_CODE_USE_VERTEX ANTHROPIC_VERTEX_PROJECT_ID ANTHROPIC_VERTEX_BASE_URL
unset CLOUD_ML_REGION CLAUDE_CODE_USE_BEDROCK ANTHROPIC_BEDROCK_BASE_URL
unset CLAUDE_CODE_USE_ANTHROPIC_AWS ANTHROPIC_AWS_BASE_URL
EOF

# Source it automatically in future interactive bash sessions
if ! grep -q 'claude-proxy-env' ~/.bashrc 2>/dev/null; then
    echo '[[ -f ~/.claude-proxy-env ]] && source ~/.claude-proxy-env' >> ~/.bashrc
fi
echo "[vm-setup] Proxy env written to ~/.claude-proxy-env"
ENVFILE
}

# ── MODE: delete ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "delete" ]]; then
    echo ""
    if ! vm_exists; then
        info "VM '$VM_NAME' does not exist in zone $GCP_ZONE — nothing to delete."
        exit 0
    fi
    warn "This will permanently delete VM '$VM_NAME' in zone $GCP_ZONE."
    read -rp "  Type the VM name to confirm: " confirm
    if [[ "$confirm" != "$VM_NAME" ]]; then
        echo "  Aborted."
        exit 1
    fi
    gcloud compute instances delete "$VM_NAME" \
        --zone="$GCP_ZONE" \
        --quiet
    success "VM '$VM_NAME' deleted."
    exit 0
fi

# ── MODE: connect (SSH into existing VM) ─────────────────────────────────────
if [[ "$MODE" == "connect" ]]; then
    echo ""
    if ! vm_exists; then
        die "VM '$VM_NAME' not found in zone $GCP_ZONE. Run without --connect to provision it first."
    fi
    # Update proxy env in case WORKER_URL or PROXY_TOKEN changed since last run
    write_proxy_env
    echo ""
    info "Connecting to VM and launching Claude Code..."
    echo ""
    # -t forces TTY; source proxy env then exec claude
    gcloud compute ssh "$VM_NAME" \
        --zone="$GCP_ZONE" \
        -- -t "bash --login -c 'source ~/.claude-proxy-env && exec claude'"
    exit 0
fi

# ── MODE: create-and-connect (default) ───────────────────────────────────────
echo ""
echo -e "${BOLD}  Provisioning Compute Engine VM${RESET}"
echo "  VM name      : $VM_NAME"
echo "  Zone         : $GCP_ZONE"
echo "  Machine type : $MACHINE_TYPE"
echo "  Disk         : $DISK_SIZE"
echo "  Worker URL   : $WORKER_URL"
echo ""

if vm_exists; then
    warn "VM '$VM_NAME' already exists — skipping creation."
    warn "Use --connect to reconnect, or --delete to remove it first."
    echo ""
    # Still update proxy env in case credentials changed
    write_proxy_env
else
    # ── Enable the Compute API ────────────────────────────────────────────────
    info "Enabling Compute Engine API..."
    gcloud services enable compute.googleapis.com --quiet

    # ── Create the VM ─────────────────────────────────────────────────────────
    # No startup-script metadata is used here — we install Claude Code over SSH
    # after the VM is up so we can see output and handle errors interactively.
    info "Creating VM '$VM_NAME' ($MACHINE_TYPE, $IMAGE_FAMILY)..."
    gcloud compute instances create "$VM_NAME" \
        --zone="$GCP_ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --image-family="$IMAGE_FAMILY" \
        --image-project="$IMAGE_PROJECT" \
        --boot-disk-size="$DISK_SIZE" \
        --boot-disk-type="pd-balanced" \
        --tags=claude-vm \
        --metadata=enable-oslogin=TRUE \
        --quiet

    success "VM created."

    # ── Wait for SSH ──────────────────────────────────────────────────────────
    wait_for_ssh

    # ── Install Claude Code ───────────────────────────────────────────────────
    install_claude_on_vm
fi

# ── Write proxy config ────────────────────────────────────────────────────────
write_proxy_env

success "VM is ready."
echo ""
echo -e "${BOLD}  Useful commands:${RESET}"
echo "  Reconnect later:  ./scripts/provision-vm.sh --connect"
echo "  Plain SSH:        gcloud compute ssh $VM_NAME --zone=$GCP_ZONE"
echo "  Delete VM:        ./scripts/provision-vm.sh --delete"
echo ""
info "Connecting and launching Claude Code..."
echo ""

# ── Connect interactively ─────────────────────────────────────────────────────
# -t forces TTY allocation for Claude Code's interactive UI.
# Source ~/.claude-proxy-env (written above) then exec claude.
gcloud compute ssh "$VM_NAME" \
    --zone="$GCP_ZONE" \
    -- -t "bash --login -c 'source ~/.claude-proxy-env && exec claude'"
