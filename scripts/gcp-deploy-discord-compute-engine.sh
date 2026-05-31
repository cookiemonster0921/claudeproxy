#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./gcp-discord-common.sh
source "$SCRIPT_DIR/gcp-discord-common.sh"

VM_NAME="${VM_NAME:-claude-discord-free}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-20GB}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project) GCP_PROJECT="$2"; shift 2 ;;
        --region) GCP_REGION="$2"; shift 2 ;;
        --zone) GCP_ZONE="$2"; shift 2 ;;
        --repo) AR_REPO="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        --vm-name) VM_NAME="$2"; shift 2 ;;
        --machine-type) MACHINE_TYPE="$2"; shift 2 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

require_command gcloud
load_dev_vars
require_runtime_vars
resolve_project

info "Enabling Compute Engine and Secret Manager APIs"
enable_services compute.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
ensure_artifact_repo
sync_runtime_secrets

SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-$(default_compute_service_account)}"
grant_runtime_secret_access "$SERVICE_ACCOUNT"
gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role=roles/artifactregistry.reader \
    --quiet >/dev/null

STARTUP_SCRIPT="$(mktemp)"
trap 'rm -f "$STARTUP_SCRIPT"' EXIT
cat > "$STARTUP_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io curl python3 ca-certificates
systemctl enable --now docker

# e2-micro has 1 GB RAM. A small disk-backed swap file reduces avoidable OOM
# exits while keeping the VM inside the standard persistent-disk free allowance.
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

metadata_token() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

secret() {
  local name="\$1"
  local token
  token="\$(metadata_token)"
  curl -fsS -H "Authorization: Bearer \$token" \
    "https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/\${name}/versions/latest:access" |
    python3 -c 'import base64,json,sys; print(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode())'
}

mkdir -p /opt/claude-discord
cat > /opt/claude-discord/runtime.env <<ENV
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
chmod 600 /opt/claude-discord/runtime.env

token="\$(metadata_token)"
printf '%s' "\$token" | docker login -u oauth2accesstoken --password-stdin "https://${AR_HOST}"
docker pull "${IMAGE_REF}"
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --env-file /opt/claude-discord/runtime.env \
  --volume claude-discord-state:/root/.claude \
  "${IMAGE_REF}"
EOF

if gcloud compute instances describe "$VM_NAME" \
    --project="$GCP_PROJECT" \
    --zone="$GCP_ZONE" \
    --quiet >/dev/null 2>&1
then
    die "VM $VM_NAME already exists. Delete it before recreating, or update it manually."
fi

info "Creating $MACHINE_TYPE VM $VM_NAME in $GCP_ZONE"
gcloud compute instances create "$VM_NAME" \
    --project="$GCP_PROJECT" \
    --zone="$GCP_ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-type=pd-standard \
    --boot-disk-size="$BOOT_DISK_SIZE" \
    --service-account="$SERVICE_ACCOUNT" \
    --scopes=cloud-platform \
    --metadata=enable-oslogin=TRUE \
    --metadata-from-file=startup-script="$STARTUP_SCRIPT" \
    --quiet

info "VM created. Startup installs Docker and launches $CONTAINER_NAME."
info "Inspect: gcloud compute ssh $VM_NAME --zone=$GCP_ZONE --project=$GCP_PROJECT --command='sudo docker logs --tail 80 $CONTAINER_NAME'"
warn "The free tier covers one e2-micro VM in eligible US regions and limited standard disk usage. e2-micro may be too small for Claude Code plus Bun; monitor for OOM exits."
