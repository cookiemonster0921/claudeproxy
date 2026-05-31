#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./gcp-discord-common.sh
source "$SCRIPT_DIR/gcp-discord-common.sh"

parse_common_args "$@"
require_command gcloud
require_command docker
resolve_project

info "Enabling Artifact Registry API"
enable_services artifactregistry.googleapis.com
ensure_artifact_repo

info "Configuring Docker authentication for $AR_HOST"
gcloud auth configure-docker "$AR_HOST" --quiet

info "Building and pushing $IMAGE_REF for linux/amd64"
docker buildx build \
    --platform=linux/amd64 \
    --tag "$IMAGE_REF" \
    --push \
    "$REPO_ROOT/chatgpt-version"

info "Pushed $IMAGE_REF"
warn "Artifact Registry includes 0.5 GB of free storage per billing account. Delete old tags if image storage grows beyond that."

