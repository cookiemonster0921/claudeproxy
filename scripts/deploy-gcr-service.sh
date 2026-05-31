#!/usr/bin/env bash
# deploy-gcr-service.sh — Build docker/Dockerfile.claude-service, push to Artifact Registry,
#                         deploy as a Cloud Run Service.
#
# A Cloud Run Service is always-on (scales to zero when idle) and exposes an
# HTTPS endpoint. Unlike a Job, it responds to HTTP requests immediately.
# This script deploys the claude-proxy HTTP wrapper that accepts:
#
#   GET  /health          → readiness probe
#   POST /run             → { "prompt": "..." } → runs claude --print, returns JSON
#   POST /run  stream=true → same but streams output as Server-Sent Events
#
# Usage:
#   ./scripts/deploy-gcr-service.sh --project YOUR_PROJECT_ID
#   ./scripts/deploy-gcr-service.sh --project YOUR_PROJECT_ID --region us-central1
#
# All flags are optional — defaults shown below.
# WORKER_URL and PROXY_TOKEN are read from .dev.vars (same as cproxy).

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[deploy]${RESET} $*"; }
success() { echo -e "${GREEN}[deploy]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[deploy]${RESET} $*"; }
die()     { echo -e "${RED}[deploy] ERROR:${RESET} $*" >&2; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────
GCP_PROJECT="${GCP_PROJECT:-}"
GCP_REGION="${GCP_REGION:-us-central1}"
AR_REPO="${AR_REPO:-claude-proxy}"
IMAGE_NAME="${IMAGE_NAME:-claude-service}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
SERVICE_NAME="${SERVICE_NAME:-claude-service}"
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-false}"  # set to true to make the URL public

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)              GCP_PROJECT="$2";              shift 2 ;;
        --region)               GCP_REGION="$2";               shift 2 ;;
        --repo)                 AR_REPO="$2";                  shift 2 ;;
        --image)                IMAGE_NAME="$2";               shift 2 ;;
        --tag)                  IMAGE_TAG="$2";                shift 2 ;;
        --service)              SERVICE_NAME="$2";             shift 2 ;;
        --allow-unauthenticated) ALLOW_UNAUTHENTICATED="true"; shift   ;;
        --help|-h)
            grep '^#' "$0" | head -30 | sed 's/^# \?//'
            exit 0
            ;;
        *) die "Unknown flag: $1. Run with --help for usage." ;;
    esac
done

# ── Read credentials from .dev.vars ──────────────────────────────────────────
DEV_VARS="$REPO_ROOT/.dev.vars"
if [[ -f "$DEV_VARS" ]]; then
    WORKER_URL="${WORKER_URL:-$(grep -E '^WORKER_URL=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    PROXY_TOKEN="${PROXY_TOKEN:-$(grep -E '^PROXY_TOKEN=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
fi

# ── Validate ──────────────────────────────────────────────────────────────────
[[ -z "$GCP_PROJECT" ]] && die "GCP_PROJECT is not set. Pass --project YOUR_PROJECT_ID or export GCP_PROJECT=..."
[[ -z "$WORKER_URL"  ]] && die "WORKER_URL is not set. Add 'WORKER_URL=https://...' to .dev.vars or export it."

WORKER_URL="${WORKER_URL%/}"
PROXY_TOKEN="${PROXY_TOKEN:-dev-token}"

AR_HOST="${GCP_REGION}-docker.pkg.dev"
IMAGE_REF="${AR_HOST}/${GCP_PROJECT}/${AR_REPO}/${IMAGE_NAME}:${IMAGE_TAG}"

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v gcloud &>/dev/null || die "gcloud CLI not installed. See https://cloud.google.com/sdk/docs/install"
command -v docker  &>/dev/null || die "Docker not installed or not running."

# ── Print plan ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Deploy plan (Cloud Run Service)${RESET}"
echo "  Project      : $GCP_PROJECT"
echo "  Region       : $GCP_REGION"
echo "  AR repo      : $AR_REPO"
echo "  Image        : $IMAGE_REF"
echo "  Service name : $SERVICE_NAME"
echo "  Worker URL   : $WORKER_URL"
echo "  Proxy token  : ${PROXY_TOKEN:0:4}$(printf '%0.s*' {1..8})"
echo "  Public URL   : $ALLOW_UNAUTHENTICATED (pass --allow-unauthenticated to make it public)"
echo ""

# ── Step 1: set project ───────────────────────────────────────────────────────
info "Setting active project to $GCP_PROJECT..."
gcloud config set project "$GCP_PROJECT" --quiet

# ── Step 2: enable APIs ───────────────────────────────────────────────────────
info "Enabling GCP APIs..."
gcloud services enable \
    artifactregistry.googleapis.com \
    run.googleapis.com \
    --quiet

# ── Step 3: create AR repo if needed ─────────────────────────────────────────
info "Checking Artifact Registry repo '$AR_REPO'..."
if ! gcloud artifacts repositories describe "$AR_REPO" \
        --location="$GCP_REGION" --quiet &>/dev/null; then
    info "Creating repo..."
    gcloud artifacts repositories create "$AR_REPO" \
        --repository-format=docker \
        --location="$GCP_REGION" \
        --description="Claude proxy Docker images" \
        --quiet
    success "Repo created."
else
    info "Repo exists — skipping."
fi

# ── Step 4: configure Docker auth ─────────────────────────────────────────────
info "Configuring Docker credentials for $AR_HOST..."
gcloud auth configure-docker "$AR_HOST" --quiet

# ── Step 5: build for linux/amd64 ────────────────────────────────────────────
info "Building image (linux/amd64)..."
docker build \
    --platform linux/amd64 \
    --file "$REPO_ROOT/docker/Dockerfile.claude-service" \
    --tag "$IMAGE_REF" \
    "$REPO_ROOT"
success "Build complete."

# ── Step 6: push ─────────────────────────────────────────────────────────────
info "Pushing image..."
docker push "$IMAGE_REF"
success "Push complete: $IMAGE_REF"

# ── Step 7: deploy Cloud Run Service ─────────────────────────────────────────
# Key differences from a Job deployment:
#   --port 8080            tells Cloud Run which port the container listens on
#   --min-instances 0      scale to zero when idle (cold start on first request)
#   --max-instances 3      cap concurrency (each instance handles one claude run)
#   --concurrency 1        one claude --print per instance at a time (CPU-bound)
#   --timeout 600          allow up to 10 min per request (long prompts)
#   --cpu-throttling       CPU is only allocated while handling a request (cheaper)
#
# PROXY_TOKEN is passed as a plain env var here.
# For production: store it in Secret Manager and use:
#   --set-secrets=PROXY_TOKEN=claude-proxy-token:latest
info "Deploying Cloud Run Service '$SERVICE_NAME'..."

AUTH_FLAG="--no-allow-unauthenticated"
[[ "$ALLOW_UNAUTHENTICATED" == "true" ]] && AUTH_FLAG="--allow-unauthenticated"

gcloud run deploy "$SERVICE_NAME" \
    --image="$IMAGE_REF" \
    --region="$GCP_REGION" \
    --platform=managed \
    --port=8080 \
    --set-env-vars="WORKER_URL=${WORKER_URL},PROXY_TOKEN=${PROXY_TOKEN}" \
    --min-instances=0 \
    --max-instances=3 \
    --concurrency=1 \
    --timeout=600 \
    --memory=512Mi \
    --cpu=1 \
    --cpu-throttling \
    $AUTH_FLAG \
    --quiet

# Fetch the service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
    --region="$GCP_REGION" \
    --format="value(status.url)")

success "Service deployed: $SERVICE_URL"

# ── Step 8: quick smoke test ──────────────────────────────────────────────────
info "Smoke-testing /health..."
# Cloud Run Services require an ID token when --no-allow-unauthenticated is set.
# gcloud generates one from your active account credentials.
if [[ "$ALLOW_UNAUTHENTICATED" == "true" ]]; then
    HEALTH=$(curl -sf "$SERVICE_URL/health" || echo '{"ok":false}')
else
    TOKEN=$(gcloud auth print-identity-token)
    HEALTH=$(curl -sf -H "Authorization: Bearer $TOKEN" "$SERVICE_URL/health" || echo '{"ok":false}')
fi
echo "  $HEALTH"

# ── Step 9: print usage ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Done. How to call the service:${RESET}"
echo ""

if [[ "$ALLOW_UNAUTHENTICATED" == "true" ]]; then
    AUTH_HEADER=""
    AUTH_NOTE="(public URL — no auth required)"
else
    AUTH_HEADER='-H "Authorization: Bearer $(gcloud auth print-identity-token)"'
    AUTH_NOTE="(requires GCP identity token — see below)"
fi

echo "  $AUTH_NOTE"
echo ""
echo "  # Health check"
echo "  curl $AUTH_HEADER \\"
echo "    $SERVICE_URL/health"
echo ""
echo "  # One-shot prompt (blocking)"
echo "  curl -X POST $AUTH_HEADER \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"prompt\": \"list the files in /workspace\"}' \\"
echo "    $SERVICE_URL/run"
echo ""
echo "  # Streaming prompt (SSE)"
echo "  curl -N -X POST $AUTH_HEADER \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"prompt\": \"explain this repo\", \"stream\": true}' \\"
echo "    $SERVICE_URL/run"
echo ""

if [[ "$ALLOW_UNAUTHENTICATED" == "false" ]]; then
    warn "The service URL is private. To call it from outside gcloud:"
    echo "  1. Get a token:   TOKEN=\$(gcloud auth print-identity-token)"
    echo "  2. Pass it:       curl -H \"Authorization: Bearer \$TOKEN\" ..."
    echo "  Or re-deploy with --allow-unauthenticated to make it public."
    echo ""
fi

echo "  Manage the service:"
echo "    gcloud run services list --region=$GCP_REGION"
echo "    gcloud run services describe $SERVICE_NAME --region=$GCP_REGION"
echo "    gcloud run services logs read $SERVICE_NAME --region=$GCP_REGION --limit=50"
echo ""
