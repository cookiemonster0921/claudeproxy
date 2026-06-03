#!/usr/bin/env bash
# spawn-discord-session.sh — Launch one Claude Code session per Discord channel.
#
# Each session is an isolated container running Claude Code + the Discord plugin.
# Communication happens entirely through Discord — no HTTP endpoint needed.
#
# Modes:
#   local       docker run -d on this machine   (default when --project is omitted)
#   cloud-run   Cloud Run Job execution on GCP
#
# Usage:
#   # Local Docker (detached container)
#   ./scripts/spawn-discord-session.sh \
#     --channel-id 1234567890123456789 \
#     --allowed-users "111222333,444555666"
#
#   # Cloud Run Job
#   ./scripts/spawn-discord-session.sh \
#     --channel-id 1234567890123456789 \
#     --allowed-users "111222333,444555666" \
#     --project my-gcp-project
#
#   # Stop a local session
#   ./scripts/spawn-discord-session.sh --stop --channel-id 1234567890123456789
#
#   # List running sessions
#   ./scripts/spawn-discord-session.sh --list

set -euo pipefail

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[session]${RESET} $*"; }
success() { echo -e "${GREEN}[session]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[session]${RESET} $*"; }
die()     { echo -e "${RED}[session] ERROR:${RESET} $*" >&2; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────
CHANNEL_ID=""
ALLOWED_USERS=""
REQUIRE_MENTION="false"
GCP_PROJECT=""
GCP_REGION="${GCP_REGION:-us-central1}"
AR_REPO="${AR_REPO:-claude-proxy}"
IMAGE_NAME="${IMAGE_NAME:-claude-discord}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ACTION="start"   # start | stop | list | build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_VARS="$REPO_ROOT/.dev.vars"

# ── Read credentials from .dev.vars ──────────────────────────────────────────
WORKER_URL="${WORKER_URL:-}"
PROXY_TOKEN="${PROXY_TOKEN:-}"
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"

if [[ -f "$DEV_VARS" ]]; then
    WORKER_URL="${WORKER_URL:-$(grep -E '^WORKER_URL=' "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    PROXY_TOKEN="${PROXY_TOKEN:-$(grep -E '^PROXY_TOKEN=' "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(grep -E '^DISCORD_BOT_TOKEN=' "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
fi

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --channel-id)       CHANNEL_ID="$2";       shift 2 ;;
        --allowed-users)    ALLOWED_USERS="$2";    shift 2 ;;
        --require-mention)  REQUIRE_MENTION="true"; shift   ;;
        --project)          GCP_PROJECT="$2";       shift 2 ;;
        --region)           GCP_REGION="$2";        shift 2 ;;
        --image-tag)        IMAGE_TAG="$2";         shift 2 ;;
        --stop)             ACTION="stop";           shift   ;;
        --list)             ACTION="list";           shift   ;;
        --build)            ACTION="build";          shift   ;;
        --help|-h)
            grep '^#' "$0" | head -25 | sed 's/^# \?//'
            exit 0
            ;;
        *) die "Unknown flag: $1. Run with --help." ;;
    esac
done

# ── Session naming ────────────────────────────────────────────────────────────
# Each session gets a deterministic name based on the channel ID so you can
# always find or stop it without tracking state externally.
session_name() {
    echo "discord-session-${1:-unknown}"
}

# ── Sync plugin into local cache and Docker build context ─────────────────────
# docker/discord-plugin/server.ts is the single source of truth.
# Before every build we push it into the local Claude plugin cache so
# cproxy sessions and container images always run the same code.
sync_plugin() {
    local plugin_src="$REPO_ROOT/docker/discord-plugin/server.ts"
    local plugin_dst="$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts"

    if [[ ! -f "$plugin_src" ]]; then
        die "Plugin source not found: $plugin_src"
    fi

    # Push to local cache (used by cproxy local sessions)
    if [[ -d "$(dirname "$plugin_dst")" ]]; then
        if ! cmp -s "$plugin_src" "$plugin_dst" 2>/dev/null; then
            info "Syncing plugin → local cache"
            cp "$plugin_src" "$plugin_dst"
        else
            info "Plugin cache is up to date."
        fi
    else
        warn "Local plugin cache not found — skipping cache sync (Docker image will still be correct)"
    fi
}

# ── Build image ────────────────────────────────────────────────────────────────
build_local() {
    info "Building claude-discord image..."
    sync_plugin
    docker build \
        --file "$REPO_ROOT/docker/Dockerfile.claude-discord" \
        --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
        "$REPO_ROOT"
    success "Built: ${IMAGE_NAME}:${IMAGE_TAG}"
}

build_for_cloud_run() {
    local image_ref="$1"
    info "Building claude-discord image for linux/amd64..."
    sync_plugin
    docker build \
        --platform linux/amd64 \
        --file "$REPO_ROOT/docker/Dockerfile.claude-discord" \
        --tag "$image_ref" \
        "$REPO_ROOT"
    success "Built: $image_ref"
}

# ── Local Docker mode ─────────────────────────────────────────────────────────
start_local() {
    [[ -z "$CHANNEL_ID" ]] && die "--channel-id is required"
    [[ -z "$DISCORD_BOT_TOKEN" ]] && die "DISCORD_BOT_TOKEN not set in .dev.vars or env"
    [[ -z "$WORKER_URL" ]] && die "WORKER_URL not set in .dev.vars or env"

    local name
    name=$(session_name "$CHANNEL_ID")

    # Stop existing session for this channel if running
    if docker inspect "$name" &>/dev/null; then
        warn "Session '$name' already running — stopping it first."
        docker stop "$name" &>/dev/null || true
        docker rm   "$name" &>/dev/null || true
    fi

    # Build image if not present
    if ! docker image inspect "${IMAGE_NAME}:${IMAGE_TAG}" &>/dev/null; then
        build_local
    fi

    info "Starting session for channel ${CHANNEL_ID}..."

    # -i keeps stdin open so docker attach can send keystrokes to claude.
    # We do NOT use -t here: the discord-autotheme.py wrapper gives Claude its
    # own internal PTY (so Claude thinks it has a terminal and stays in
    # interactive/channel mode). Without -t on the outer container, stdout is a
    # plain pipe, which lets docker logs / Docker Desktop show clean text
    # instead of raw ANSI escape sequences.
    docker run -d -i \
        --name "$name" \
        --restart unless-stopped \
        -e "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}" \
        -e "DISCORD_ALLOWED_CHANNEL=${CHANNEL_ID}" \
        -e "DISCORD_ALLOWED_USERS=${ALLOWED_USERS}" \
        -e "DISCORD_REQUIRE_MENTION=${REQUIRE_MENTION}" \
        -e "WORKER_URL=${WORKER_URL}" \
        -e "PROXY_TOKEN=${PROXY_TOKEN:-dev-token}" \
        "${IMAGE_NAME}:${IMAGE_TAG}"

    success "Session started: $name"
    echo ""
    echo "  Logs:  docker logs -f $name"
    echo "  Stop:  $0 --stop --channel-id $CHANNEL_ID"
    echo ""
}

stop_local() {
    [[ -z "$CHANNEL_ID" ]] && die "--channel-id is required"
    local name
    name=$(session_name "$CHANNEL_ID")

    if docker inspect "$name" &>/dev/null; then
        info "Stopping session '$name'..."
        docker stop "$name"
        docker rm   "$name"
        success "Session stopped."
    else
        warn "No session found for channel $CHANNEL_ID (expected container name: $name)"
    fi
}

list_local() {
    info "Running Discord sessions:"
    echo ""
    docker ps --filter "name=discord-session-" \
        --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.RunningFor}}"
}

# ── Cloud Run mode ────────────────────────────────────────────────────────────
start_cloud_run() {
    [[ -z "$CHANNEL_ID" ]] && die "--channel-id is required"
    [[ -z "$GCP_PROJECT" ]] && die "--project is required for Cloud Run mode"
    [[ -z "$DISCORD_BOT_TOKEN" ]] && die "DISCORD_BOT_TOKEN not set in .dev.vars or env"
    [[ -z "$WORKER_URL" ]] && die "WORKER_URL not set in .dev.vars or env"

    command -v gcloud &>/dev/null || die "gcloud CLI not installed."
    command -v docker  &>/dev/null || die "Docker not installed."

    WORKER_URL="${WORKER_URL%/}"

    local ar_host="${GCP_REGION}-docker.pkg.dev"
    local image_ref="${ar_host}/${GCP_PROJECT}/${AR_REPO}/${IMAGE_NAME}:${IMAGE_TAG}"
    local job_name
    job_name=$(session_name "$CHANNEL_ID")

    echo ""
    echo -e "${BOLD}  Discord Session — Cloud Run${RESET}"
    echo "  Project  : $GCP_PROJECT"
    echo "  Region   : $GCP_REGION"
    echo "  Channel  : $CHANNEL_ID"
    echo "  Job name : $job_name"
    echo "  Image    : $image_ref"
    echo ""

    # Enable APIs
    info "Enabling GCP APIs..."
    gcloud services enable \
        artifactregistry.googleapis.com \
        run.googleapis.com \
        --project="$GCP_PROJECT" \
        --quiet

    # Create AR repo if needed
    if ! gcloud artifacts repositories describe "$AR_REPO" \
            --location="$GCP_REGION" --project="$GCP_PROJECT" --quiet &>/dev/null; then
        info "Creating Artifact Registry repo '$AR_REPO'..."
        gcloud artifacts repositories create "$AR_REPO" \
            --repository-format=docker \
            --location="$GCP_REGION" \
            --project="$GCP_PROJECT" \
            --description="Claude proxy Docker images" \
            --quiet
    fi

    # Auth Docker
    gcloud auth configure-docker "$ar_host" --quiet

    # Build and push
    build_for_cloud_run "$image_ref"
    info "Pushing image..."
    docker push "$image_ref"
    success "Image pushed: $image_ref"

    # Create or update the Cloud Run Job for this channel
    # Each channel gets its own named job so sessions are independently managed.
    # Task timeout: 86400s (24h — Cloud Run Jobs max). For longer sessions use GKE.
    local env_vars="DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}"
    env_vars+=",DISCORD_ALLOWED_CHANNEL=${CHANNEL_ID}"
    env_vars+=",WORKER_URL=${WORKER_URL}"
    env_vars+=",PROXY_TOKEN=${PROXY_TOKEN:-dev-token}"
    env_vars+=",DISCORD_REQUIRE_MENTION=${REQUIRE_MENTION}"
    [[ -n "$ALLOWED_USERS" ]] && env_vars+=",DISCORD_ALLOWED_USERS=${ALLOWED_USERS}"

    local common_flags=(
        --image="$image_ref"
        --region="$GCP_REGION"
        --project="$GCP_PROJECT"
        --set-env-vars="$env_vars"
        --max-retries=1
        --task-timeout=86400
        --memory=512Mi
        --cpu=1
        --quiet
    )

    if gcloud run jobs describe "$job_name" \
            --region="$GCP_REGION" --project="$GCP_PROJECT" --quiet &>/dev/null; then
        info "Updating existing job '$job_name'..."
        gcloud run jobs update "$job_name" "${common_flags[@]}"
    else
        info "Creating Cloud Run job '$job_name'..."
        gcloud run jobs create "$job_name" "${common_flags[@]}"
    fi

    # Execute the job (start the session)
    info "Starting session (job execution)..."
    gcloud run jobs execute "$job_name" \
        --region="$GCP_REGION" \
        --project="$GCP_PROJECT" \
        --quiet

    success "Session started for channel ${CHANNEL_ID}"
    echo ""
    echo "  View logs:"
    echo "    gcloud run jobs executions list --job=$job_name --region=$GCP_REGION --project=$GCP_PROJECT"
    echo "    gcloud logging read 'resource.labels.job_name=\"$job_name\"' --limit=50 --project=$GCP_PROJECT"
    echo ""
    echo "  Stop the session:"
    echo "    $0 --stop --channel-id $CHANNEL_ID --project $GCP_PROJECT"
    echo ""
    echo "  ℹ  Cloud Run Jobs have a 24h task timeout. To restart after expiry:"
    echo "    $0 --channel-id $CHANNEL_ID --project $GCP_PROJECT"
    echo ""
}

stop_cloud_run() {
    [[ -z "$CHANNEL_ID" ]] && die "--channel-id is required"
    [[ -z "$GCP_PROJECT" ]] && die "--project is required"
    command -v gcloud &>/dev/null || die "gcloud CLI not installed."

    local job_name
    job_name=$(session_name "$CHANNEL_ID")

    info "Cancelling active executions for job '$job_name'..."

    # Find and cancel the latest running execution
    local exec_name
    exec_name=$(gcloud run jobs executions list \
        --job="$job_name" \
        --region="$GCP_REGION" \
        --project="$GCP_PROJECT" \
        --filter="status.conditions.type=Running" \
        --format="value(name)" \
        --limit=1 2>/dev/null || true)

    if [[ -n "$exec_name" ]]; then
        gcloud run jobs executions cancel "$exec_name" \
            --region="$GCP_REGION" \
            --project="$GCP_PROJECT" \
            --quiet
        success "Session stopped: $exec_name"
    else
        warn "No running execution found for job '$job_name'"
    fi
}

list_cloud_run() {
    [[ -z "$GCP_PROJECT" ]] && die "--project is required"
    info "Discord sessions on Cloud Run (region: $GCP_REGION):"
    echo ""
    gcloud run jobs list \
        --region="$GCP_REGION" \
        --project="$GCP_PROJECT" \
        --filter="name:discord-session-" \
        --format="table(name,status.conditions[0].type,metadata.creationTimestamp)"
}

# ── Main ──────────────────────────────────────────────────────────────────────
case "$ACTION" in
    build)
        sync_plugin
        build_local
        ;;
    list)
        if [[ -n "$GCP_PROJECT" ]]; then
            list_cloud_run
        else
            list_local
        fi
        ;;
    stop)
        if [[ -n "$GCP_PROJECT" ]]; then
            stop_cloud_run
        else
            stop_local
        fi
        ;;
    start)
        if [[ -n "$GCP_PROJECT" ]]; then
            start_cloud_run
        else
            start_local
        fi
        ;;
esac
