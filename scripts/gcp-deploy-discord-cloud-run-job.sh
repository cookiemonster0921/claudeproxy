#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./gcp-discord-common.sh
source "$SCRIPT_DIR/gcp-discord-common.sh"

JOB_NAME="${JOB_NAME:-claude-discord-experiment}"
TASK_TIMEOUT="${TASK_TIMEOUT:-24h}"
ACK=false
EXECUTE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project) GCP_PROJECT="$2"; shift 2 ;;
        --region) GCP_REGION="$2"; shift 2 ;;
        --repo) AR_REPO="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        --job-name) JOB_NAME="$2"; shift 2 ;;
        --task-timeout) TASK_TIMEOUT="$2"; shift 2 ;;
        --execute) EXECUTE=true; shift ;;
        --acknowledge-time-limited-runtime) ACK=true; shift ;;
        *) die "Unknown argument: $1" ;;
    esac
done

[[ "$ACK" == true ]] || die "This Discord listener intentionally never exits, while Cloud Run Jobs are finite executions. Re-run with --acknowledge-time-limited-runtime to deploy an experiment."

require_command gcloud
load_dev_vars
require_runtime_vars
resolve_project

info "Enabling Cloud Run and Secret Manager APIs"
enable_services run.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
ensure_artifact_repo
sync_runtime_secrets

SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-$(default_compute_service_account)}"
grant_runtime_secret_access "$SERVICE_ACCOUNT"

FLAGS=(
    --project="$GCP_PROJECT"
    --region="$GCP_REGION"
    --image="$IMAGE_REF"
    --service-account="$SERVICE_ACCOUNT"
    --cpu=1
    --memory=512Mi
    --tasks=1
    --max-retries=0
    --task-timeout="$TASK_TIMEOUT"
    --set-env-vars="$(runtime_env_csv)"
    --set-secrets="$(runtime_secrets_csv)"
    --quiet
)

if gcloud run jobs describe "$JOB_NAME" --project="$GCP_PROJECT" --region="$GCP_REGION" --quiet >/dev/null 2>&1; then
    info "Updating Cloud Run Job $JOB_NAME"
    gcloud run jobs update "$JOB_NAME" "${FLAGS[@]}"
else
    info "Creating Cloud Run Job $JOB_NAME"
    gcloud run jobs create "$JOB_NAME" "${FLAGS[@]}"
fi

info "Cloud Run Job deployed. It has ephemeral filesystem state and stops after $TASK_TIMEOUT."
if [[ "$EXECUTE" == true ]]; then
    gcloud run jobs execute "$JOB_NAME" \
        --project="$GCP_PROJECT" \
        --region="$GCP_REGION" \
        --async
    info "Execution started."
else
    info "Start it with: gcloud run jobs execute $JOB_NAME --project=$GCP_PROJECT --region=$GCP_REGION --async"
fi
warn "A continuously running Job consumes Cloud Run compute quota while active. It is not guaranteed to remain within the free tier."

