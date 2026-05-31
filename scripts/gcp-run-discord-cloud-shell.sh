#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./gcp-discord-common.sh
source "$SCRIPT_DIR/gcp-discord-common.sh"

ACTION="start"

while [[ $# -gt 0 ]]; do
    case "$1" in
        start|stop|logs|status) ACTION="$1"; shift ;;
        --project) GCP_PROJECT="$2"; shift 2 ;;
        --region) GCP_REGION="$2"; shift 2 ;;
        --repo) AR_REPO="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

require_command gcloud
load_dev_vars
require_runtime_vars
resolve_project

case "$ACTION" in
    start)
        info "Enabling Secret Manager API"
        enable_services secretmanager.googleapis.com artifactregistry.googleapis.com
        ensure_artifact_repo
        sync_runtime_secrets

        info "Starting Cloud Shell and launching $CONTAINER_NAME"
        gcloud cloud-shell ssh \
            --authorize-session \
            --command="bash -s" <<EOF
set -euo pipefail

metadata_token() {
  gcloud auth print-access-token
}

secret() {
  local name="\$1"
  local token
  token="\$(metadata_token)"
  curl -fsS -H "Authorization: Bearer \$token" \
    "https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/\${name}/versions/latest:access" |
    python3 -c 'import base64,json,sys; print(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode())'
}

mkdir -p "\$HOME/.claude-discord-cloud-shell"
cat > "\$HOME/.claude-discord-cloud-shell/runtime.env" <<ENV
WORKER_URL=${WORKER_URL}
CLAUDE_MODEL=${CLAUDE_MODEL}
DISCORD_CHANNEL_IDS=${DISCORD_CHANNEL_IDS:-}
DISCORD_USER_IDS=${DISCORD_USER_IDS}
DISCORD_DM_POLICY=${DISCORD_DM_POLICY}
DISCORD_REQUIRE_MENTION=${DISCORD_REQUIRE_MENTION:-false}
ANTHROPIC_API_KEY=\$(secret "$(secret_name anthropic-api-key)")
DISCORD_BOT_TOKEN=\$(secret "$(secret_name discord-bot-token)")
PROXY_TOKEN=\$(secret "$(secret_name proxy-token)")
ENV
chmod 600 "\$HOME/.claude-discord-cloud-shell/runtime.env"

token="\$(metadata_token)"
printf '%s' "\$token" | docker login -u oauth2accesstoken --password-stdin "https://${AR_HOST}"
docker pull "${IMAGE_REF}"
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run -d \
  --name "${CONTAINER_NAME}" \
  --env-file "\$HOME/.claude-discord-cloud-shell/runtime.env" \
  --volume "\$HOME/.claude-discord-cloud-shell/state:/root/.claude" \
  "${IMAGE_REF}"
sleep 5
docker logs --tail 80 "${CONTAINER_NAME}"
EOF
        warn "Cloud Shell is temporary: non-interactive sessions end automatically after 40 minutes and interactive sessions are capped at 12 hours."
        ;;
    stop)
        info "Stopping $CONTAINER_NAME in Cloud Shell"
        gcloud cloud-shell ssh --authorize-session \
            --command="docker rm -f '$CONTAINER_NAME' >/dev/null 2>&1 || true"
        ;;
    logs)
        gcloud cloud-shell ssh --authorize-session \
            --command="docker logs --tail 100 '$CONTAINER_NAME'"
        ;;
    status)
        gcloud cloud-shell ssh --authorize-session \
            --command="docker ps --filter name='$CONTAINER_NAME' --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
        ;;
esac

