#!/usr/bin/env bash
# deploy-gcr.sh — Build docker/Dockerfile.claude, push to Artifact Registry, deploy to Cloud Run Job.
#
# What this does (in order):
#   1. Reads WORKER_URL + PROXY_TOKEN from .dev.vars (or env)
#   2. Enables required GCP APIs (one-time, idempotent)
#   3. Creates the Artifact Registry repo if it doesn't exist yet
#   4. Configures Docker to authenticate with AR
#   5. Builds the image for linux/amd64 (Cloud Run only runs amd64)
#   6. Pushes the image to Artifact Registry
#   7. Creates or updates a Cloud Run Job with WORKER_URL + PROXY_TOKEN as env vars
#   8. Prints the gcloud command to actually execute the job
#
# NOTE — interactive TTY:
#   Cloud Run Jobs do not attach a TTY. Claude Code will still run (it detects
#   non-TTY and falls back to pipe/batch mode), but you won't get the
#   interactive REPL. Use `gcloud run jobs execute --wait --follow-logs` to
#   stream output, or pass a prompt via the CLAUDE_CODE_INITIAL_PROMPT env var.
#   For a fully interactive session consider running the image locally with:
#     docker run -it --rm -e WORKER_URL=... -e PROXY_TOKEN=... claude-interactive
#
# Usage:
#   ./scripts/deploy-gcr.sh [--project PROJECT] [--region REGION] [--tag TAG]
#
# All flags are optional — defaults are shown below.
# Credentials come from .dev.vars (same file the proxy reads). Never commit that file.

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[deploy]${RESET} $*"; }
success() { echo -e "${GREEN}[deploy]${RESET} $*"; }
die()     { echo -e "${RED}[deploy] ERROR:${RESET} $*" >&2; exit 1; }

# ── Defaults (override via flags or env) ──────────────────────────────────────
GCP_PROJECT="${GCP_PROJECT:-}"          # required — set via flag or env
GCP_REGION="${GCP_REGION:-us-central1}" # Cloud Run + AR region
AR_REPO="${AR_REPO:-claude-proxy}"      # Artifact Registry repo name
IMAGE_NAME="${IMAGE_NAME:-claude-interactive}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
JOB_NAME="${JOB_NAME:-claude-interactive}"  # Cloud Run Job name

# ── Script location so we can find .dev.vars and docker/Dockerfile.claude ─────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)  GCP_PROJECT="$2";  shift 2 ;;
        --region)   GCP_REGION="$2";   shift 2 ;;
        --repo)     AR_REPO="$2";      shift 2 ;;
        --image)    IMAGE_NAME="$2";   shift 2 ;;
        --tag)      IMAGE_TAG="$2";    shift 2 ;;
        --job)      JOB_NAME="$2";     shift 2 ;;
        --help|-h)
            grep '^#' "$0" | head -30 | sed 's/^# \?//'
            exit 0
            ;;
        *) die "Unknown flag: $1. Run with --help for usage." ;;
    esac
done

# ── Read WORKER_URL and PROXY_TOKEN from .dev.vars (same source as cproxy) ───
DEV_VARS="$REPO_ROOT/.dev.vars"
if [[ -f "$DEV_VARS" ]]; then
    WORKER_URL="${WORKER_URL:-$(grep -E '^WORKER_URL=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    PROXY_TOKEN="${PROXY_TOKEN:-$(grep -E '^PROXY_TOKEN=' "$DEV_VARS" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
fi

# ── Validate required values ──────────────────────────────────────────────────
[[ -z "$GCP_PROJECT" ]] && die "GCP_PROJECT is not set. Pass --project YOUR_PROJECT_ID or export GCP_PROJECT=..."
[[ -z "$WORKER_URL"  ]] && die "WORKER_URL is not set. Add 'WORKER_URL=https://...' to .dev.vars or export it."

WORKER_URL="${WORKER_URL%/}"            # strip trailing slash
PROXY_TOKEN="${PROXY_TOKEN:-dev-token}" # fall back to dev-token if not set

# ── Full image reference for Artifact Registry ────────────────────────────────
AR_HOST="${GCP_REGION}-docker.pkg.dev"
IMAGE_REF="${AR_HOST}/${GCP_PROJECT}/${AR_REPO}/${IMAGE_NAME}:${IMAGE_TAG}"

# ── Preflight: require gcloud ─────────────────────────────────────────────────
command -v gcloud &>/dev/null || die "gcloud is not installed. Install it from https://cloud.google.com/sdk/docs/install"
command -v docker  &>/dev/null || die "docker is not installed or not running."

# ── Print plan ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Deploy plan${RESET}"
echo "  Project    : $GCP_PROJECT"
echo "  Region     : $GCP_REGION"
echo "  AR repo    : $AR_REPO"
echo "  Image      : $IMAGE_REF"
echo "  Job name   : $JOB_NAME"
echo "  Worker URL : $WORKER_URL"
echo "  Proxy token: ${PROXY_TOKEN:0:4}$(printf '%0.s*' {1..8})"  # show only first 4 chars
echo ""

# ── Step 1: set active GCP project ───────────────────────────────────────────
info "Setting active project to $GCP_PROJECT..."
gcloud config set project "$GCP_PROJECT" --quiet

# ── Step 2: enable required APIs (idempotent) ─────────────────────────────────
info "Enabling GCP APIs (artifactregistry, run, cloudbuild)..."
gcloud services enable \
    artifactregistry.googleapis.com \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    --quiet

# ── Step 3: create Artifact Registry repo if it doesn't exist ────────────────
info "Checking Artifact Registry repo '$AR_REPO'..."
if ! gcloud artifacts repositories describe "$AR_REPO" \
        --location="$GCP_REGION" --quiet &>/dev/null; then
    info "Repo not found — creating it..."
    gcloud artifacts repositories create "$AR_REPO" \
        --repository-format=docker \
        --location="$GCP_REGION" \
        --description="Claude proxy Docker images" \
        --quiet
    success "Repo created: $AR_HOST/$GCP_PROJECT/$AR_REPO"
else
    info "Repo already exists — skipping creation."
fi

# ── Step 4: configure Docker to authenticate with Artifact Registry ───────────
info "Configuring Docker credentials for $AR_HOST..."
gcloud auth configure-docker "$AR_HOST" --quiet

# ── Step 5: build the image for linux/amd64 ──────────────────────────────────
# Cloud Run only runs amd64 containers. --platform ensures the correct arch
# even when building on an Apple Silicon (arm64) Mac.
info "Building image (linux/amd64)..."
docker build \
    --platform linux/amd64 \
    --file "$REPO_ROOT/docker/Dockerfile.claude" \
    --tag "$IMAGE_REF" \
    "$REPO_ROOT"

success "Build complete: $IMAGE_REF"

# ── Step 6: push to Artifact Registry ────────────────────────────────────────
info "Pushing image to Artifact Registry..."
docker push "$IMAGE_REF"
success "Push complete: $IMAGE_REF"

# ── Step 7: create or update the Cloud Run Job ───────────────────────────────
# Cloud Run Jobs (not Services) are the right primitive here because Claude
# Code is a short-lived CLI process, not a persistent HTTP server.
#
# PROXY_TOKEN is passed as an env var. For production deployments, prefer
# storing it as a Secret Manager secret and using --set-secrets instead of
# --set-env-vars so the value never appears in plain text in job metadata.
# See: gcloud run jobs update --set-secrets PROXY_TOKEN=my-secret:latest
info "Deploying Cloud Run Job '$JOB_NAME'..."

# Check if the job already exists so we can create vs. update
JOB_EXISTS=false
if gcloud run jobs describe "$JOB_NAME" \
        --region="$GCP_REGION" --quiet &>/dev/null; then
    JOB_EXISTS=true
fi

COMMON_FLAGS=(
    --image="$IMAGE_REF"
    --region="$GCP_REGION"
    --set-env-vars="WORKER_URL=${WORKER_URL},PROXY_TOKEN=${PROXY_TOKEN}"
    --max-retries=0
    --task-timeout=3600    # 1 hour max; Claude Code sessions are interactive
    --memory=512Mi
    --cpu=1
    --quiet
)

if [[ "$JOB_EXISTS" == "true" ]]; then
    info "Job already exists — updating..."
    gcloud run jobs update "$JOB_NAME" "${COMMON_FLAGS[@]}"
else
    info "Creating new job..."
    gcloud run jobs create "$JOB_NAME" "${COMMON_FLAGS[@]}"
fi

success "Job deployed: $JOB_NAME (region: $GCP_REGION)"

# ── Step 8: print next steps ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Done. Next steps:${RESET}"
echo ""
echo "  Execute the job and stream its logs:"
echo "    gcloud run jobs execute $JOB_NAME \\"
echo "      --region=$GCP_REGION \\"
echo "      --wait"
echo ""
echo "  ⚠  Cloud Run Jobs do not attach a TTY. Claude Code runs in"
echo "     non-interactive (pipe) mode and output is streamed via logs."
echo "     For a true interactive session, run the image locally:"
echo ""
echo "    docker run -it --rm \\"
echo "      -e WORKER_URL=\"$WORKER_URL\" \\"
echo "      -e PROXY_TOKEN=\"$PROXY_TOKEN\" \\"
echo "      -v \"\$(pwd)\":/workspace \\"
echo "      $IMAGE_NAME"
echo ""
echo "  Manage the deployed job:"
echo "    gcloud run jobs list --region=$GCP_REGION"
echo "    gcloud run jobs describe $JOB_NAME --region=$GCP_REGION"
echo "    gcloud run jobs executions list --job=$JOB_NAME --region=$GCP_REGION"
echo ""
