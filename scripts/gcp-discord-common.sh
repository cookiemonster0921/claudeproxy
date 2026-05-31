#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DEV_VARS="${DEV_VARS:-$REPO_ROOT/.dev.vars}"

GCP_REGION="${GCP_REGION:-us-central1}"
AR_REPO="${AR_REPO:-claude-discord}"
IMAGE_NAME="${IMAGE_NAME:-claude-discord}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
CONTAINER_NAME="${CONTAINER_NAME:-claude-discord-chatgpt-version}"

info() { printf '[gcp] %s\n' "$*"; }
warn() { printf '[gcp] WARNING: %s\n' "$*" >&2; }
die() { printf '[gcp] ERROR: %s\n' "$*" >&2; exit 1; }

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is required."
}

load_dev_vars() {
    [[ -f "$DEV_VARS" ]] || die "Missing $DEV_VARS"
    set -a
    # shellcheck disable=SC1090
    source "$DEV_VARS"
    set +a
    PROXY_TOKEN="${PROXY_TOKEN:-dev-token}"
}

require_runtime_vars() {
    local name
    for name in \
        WORKER_URL \
        ANTHROPIC_API_KEY \
        DISCORD_BOT_TOKEN \
        CLAUDE_MODEL \
        DISCORD_USER_IDS \
        DISCORD_DM_POLICY
    do
        [[ -n "${!name:-}" ]] || die "$name must be set in $DEV_VARS or the shell environment."
    done
}

resolve_project() {
    GCP_PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
    [[ -n "$GCP_PROJECT" && "$GCP_PROJECT" != "(unset)" ]] ||
        die "Pass --project PROJECT_ID or set a gcloud default project."
    AR_HOST="${GCP_REGION}-docker.pkg.dev"
    IMAGE_REF="${AR_HOST}/${GCP_PROJECT}/${AR_REPO}/${IMAGE_NAME}:${IMAGE_TAG}"
}

parse_common_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --project) GCP_PROJECT="$2"; shift 2 ;;
            --region) GCP_REGION="$2"; shift 2 ;;
            --repo) AR_REPO="$2"; shift 2 ;;
            --tag) IMAGE_TAG="$2"; shift 2 ;;
            *) die "Unknown argument: $1" ;;
        esac
    done
}

enable_services() {
    gcloud services enable "$@" --project="$GCP_PROJECT" --quiet
}

ensure_artifact_repo() {
    if ! gcloud artifacts repositories describe "$AR_REPO" \
        --project="$GCP_PROJECT" \
        --location="$GCP_REGION" \
        --quiet >/dev/null 2>&1
    then
        info "Creating Artifact Registry repository $AR_REPO in $GCP_REGION"
        gcloud artifacts repositories create "$AR_REPO" \
            --project="$GCP_PROJECT" \
            --location="$GCP_REGION" \
            --repository-format=docker \
            --description="Claude Discord container images" \
            --quiet
    fi
}

secret_name() {
    printf 'claude-discord-%s' "$1"
}

sync_secret() {
    local env_name="$1"
    local secret
    secret="$(secret_name "$(printf '%s' "$env_name" | tr '[:upper:]_' '[:lower:]-')")"

    if ! gcloud secrets describe "$secret" --project="$GCP_PROJECT" --quiet >/dev/null 2>&1; then
        info "Creating Secret Manager secret $secret"
        gcloud secrets create "$secret" \
            --project="$GCP_PROJECT" \
            --replication-policy=automatic \
            --quiet
    fi

    local current
    current="$(gcloud secrets versions access latest --secret="$secret" --project="$GCP_PROJECT" 2>/dev/null || true)"
    if [[ "$current" == "${!env_name}" ]]; then
        info "Secret $secret is unchanged"
        return
    fi

    info "Adding a new version for $secret"
    printf '%s' "${!env_name}" |
        gcloud secrets versions add "$secret" \
            --project="$GCP_PROJECT" \
            --data-file=- \
            --quiet >/dev/null
}

sync_runtime_secrets() {
    sync_secret ANTHROPIC_API_KEY
    sync_secret DISCORD_BOT_TOKEN
    sync_secret PROXY_TOKEN
}

runtime_env_csv() {
    printf '%s' \
        "^|^WORKER_URL=${WORKER_URL}|"\
"CLAUDE_MODEL=${CLAUDE_MODEL}|"\
"DISCORD_CHANNEL_IDS=${DISCORD_CHANNEL_IDS:-}|"\
"DISCORD_USER_IDS=${DISCORD_USER_IDS}|"\
"DISCORD_DM_POLICY=${DISCORD_DM_POLICY}|"\
"DISCORD_REQUIRE_MENTION=${DISCORD_REQUIRE_MENTION:-false}"
}

runtime_secrets_csv() {
    printf '%s' \
        "ANTHROPIC_API_KEY=$(secret_name anthropic-api-key):latest,"\
"DISCORD_BOT_TOKEN=$(secret_name discord-bot-token):latest,"\
"PROXY_TOKEN=$(secret_name proxy-token):latest"
}

default_compute_service_account() {
    local project_number
    project_number="$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')"
    printf '%s-compute@developer.gserviceaccount.com' "$project_number"
}

grant_runtime_secret_access() {
    local service_account="$1"
    local secret
    for secret in \
        "$(secret_name anthropic-api-key)" \
        "$(secret_name discord-bot-token)" \
        "$(secret_name proxy-token)"
    do
        gcloud secrets add-iam-policy-binding "$secret" \
            --project="$GCP_PROJECT" \
            --member="serviceAccount:${service_account}" \
            --role=roles/secretmanager.secretAccessor \
            --quiet >/dev/null
    done
}
