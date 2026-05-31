#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./gcp-discord-common.sh
source "$SCRIPT_DIR/gcp-discord-common.sh"

SERVICE_NAME="${SERVICE_NAME:-claude-discord-experiment}"
ACK=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project) GCP_PROJECT="$2"; shift 2 ;;
        --region) GCP_REGION="$2"; shift 2 ;;
        --repo) AR_REPO="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        --service-name) SERVICE_NAME="$2"; shift 2 ;;
        --acknowledge-incompatible-runtime) ACK=true; shift ;;
        *) die "Unknown argument: $1" ;;
    esac
done

[[ "$ACK" == true ]] || die "This image does not listen on PORT, so Cloud Run Service deployment is expected to fail its startup health check. Re-run with --acknowledge-incompatible-runtime to test that behavior."

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

warn "Deploying an intentionally incompatible experiment: the current Discord image does not listen on PORT."
gcloud run deploy "$SERVICE_NAME" \
    --project="$GCP_PROJECT" \
    --region="$GCP_REGION" \
    --image="$IMAGE_REF" \
    --service-account="$SERVICE_ACCOUNT" \
    --cpu=1 \
    --memory=512Mi \
    --min=0 \
    --max=1 \
    --no-allow-unauthenticated \
    --set-env-vars="$(runtime_env_csv)" \
    --set-secrets="$(runtime_secrets_csv)" \
    --quiet

