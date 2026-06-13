#!/usr/bin/env bash
# setup.sh — Build, push, and deploy the launcher daemon to Northflank.
#
# ── What this script does ─────────────────────────────────────────────────────
#   1. Reads WORKER_URL + PROXY_TOKEN from .dev.vars
#   2. Builds the Docker image (python + Node.js + Claude Code + tmux)
#   3. Pushes it to Docker Hub (or GHCR)
#   4. Creates a Northflank project (if it doesn't exist)
#   5. Creates a Northflank secret group with LAUNCHER_WS_URL + PROXY_TOKEN
#   6. Creates (or updates) a deployment service that pulls the image
#
# ── Prerequisites ─────────────────────────────────────────────────────────────
#   npm install -g @northflank/cli    # Northflank CLI
#   northflank login                  # authenticate (needs API token from dashboard)
#   docker login                      # authenticate with Docker Hub (or GHCR)
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#   ./scripts/northflank/setup.sh \
#       --image YOUR_DOCKERHUB_USER/claude-launcher   # required on first run
#
#   ./scripts/northflank/setup.sh --image YOUR_USER/claude-launcher --update
#       # rebuild, push, and trigger a new deployment
#
#   ./scripts/northflank/setup.sh --logs     # stream service logs
#   ./scripts/northflank/setup.sh --status   # show service status
#   ./scripts/northflank/setup.sh --delete   # delete project + service

set -euo pipefail

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[northflank]${RESET} $*"; }
success() { echo -e "${GREEN}[northflank]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[northflank]${RESET} $*"; }
die()     { echo -e "${RED}[northflank] ERROR:${RESET} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEV_VARS="$REPO_ROOT/.dev.vars"

# ── Defaults ──────────────────────────────────────────────────────────────────
IMAGE_NAME=""          # e.g. youruser/claude-launcher
IMAGE_TAG="latest"
NF_PROJECT="claude-discord"
NF_SERVICE="claude-discord-launcher"
NF_SECRET_GROUP="claude-launcher-secrets"
MODE="deploy"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --image)    IMAGE_NAME="$2"; shift 2 ;;
        --tag)      IMAGE_TAG="$2";  shift 2 ;;
        --project)  NF_PROJECT="$2"; shift 2 ;;
        --update)   MODE="update";   shift   ;;
        --logs)     MODE="logs";     shift   ;;
        --status)   MODE="status";   shift   ;;
        --delete)   MODE="delete";   shift   ;;
        --help|-h)  grep '^#' "$0" | head -30 | sed 's/^# \?//'; exit 0 ;;
        *) die "Unknown flag: $1. Run with --help." ;;
    esac
done

# ── Prerequisite checks ───────────────────────────────────────────────────────
command -v northflank &>/dev/null || die "Northflank CLI not installed. Run: npm install -g @northflank/cli"
command -v docker     &>/dev/null || die "Docker is required to build the image."
[[ -f "$DEV_VARS" ]]              || die ".dev.vars not found at $REPO_ROOT/.dev.vars"

# ── Read credentials ──────────────────────────────────────────────────────────
_read_var() {
    grep -E "^${1}=" "$DEV_VARS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}
WORKER_URL="$(_read_var WORKER_URL)"
PROXY_TOKEN="$(_read_var PROXY_TOKEN)"
ANTHROPIC_API_KEY="$(_read_var ANTHROPIC_API_KEY)"
[[ -z "$ANTHROPIC_API_KEY" ]] && ANTHROPIC_API_KEY="$PROXY_TOKEN"
[[ -n "$WORKER_URL"  ]] || die "WORKER_URL not set in .dev.vars"
[[ -n "$PROXY_TOKEN" ]] || die "PROXY_TOKEN not set in .dev.vars"
WS_URL="$(echo "$WORKER_URL" | sed 's|https://|wss://|; s|http://|ws://|')"/launcher-ws

# ── LOGS ──────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "logs" ]]; then
    info "Streaming logs for $NF_SERVICE in project $NF_PROJECT ..."
    # Get project ID
    PROJECT_ID=$(northflank get project --project "$NF_PROJECT" --output json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null || true)
    [[ -n "$PROJECT_ID" ]] || die "Project '$NF_PROJECT' not found. Run setup.sh first."
    exec northflank get logs --project "$PROJECT_ID" --service "$NF_SERVICE" --follow
fi

# ── STATUS ────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "status" ]]; then
    echo ""
    echo -e "${BOLD}  Northflank project: $NF_PROJECT${RESET}"
    northflank get service --project "$NF_PROJECT" --service "$NF_SERVICE" 2>/dev/null || echo "  Service not found."
    echo ""
    exit 0
fi

# ── DELETE ────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "delete" ]]; then
    echo ""
    warn "This will delete the Northflank project '$NF_PROJECT' and ALL its services."
    read -rp "  Type the project name to confirm: " confirm
    [[ "$confirm" != "$NF_PROJECT" ]] && { echo "  Aborted."; exit 1; }
    northflank delete project --project "$NF_PROJECT" --confirm || true
    success "Project '$NF_PROJECT' deleted."
    exit 0
fi

# ── IMAGE NAME REQUIRED FOR DEPLOY ───────────────────────────────────────────
[[ -n "$IMAGE_NAME" ]] || die "--image is required. Example: --image youruser/claude-launcher"
IMAGE_REF="${IMAGE_NAME}:${IMAGE_TAG}"

# ── BUILD + PUSH ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Building Docker image: $IMAGE_REF${RESET}"
echo ""

cd "$REPO_ROOT"
docker build \
    --file scripts/northflank/Dockerfile.launcher \
    --tag "$IMAGE_REF" \
    --platform linux/amd64 \
    .

info "Pushing $IMAGE_REF ..."
docker push "$IMAGE_REF"
success "Image pushed: $IMAGE_REF"

# ── If update: just push the image; Northflank detects the new digest ─────────
if [[ "$MODE" == "update" ]]; then
    echo ""
    success "Image updated. Northflank will automatically redeploy the service."
    info "Force redeploy: northflank trigger deployment --project $NF_PROJECT --service $NF_SERVICE"
    exit 0
fi

# ── CREATE PROJECT ────────────────────────────────────────────────────────────
echo ""
info "Creating Northflank project '$NF_PROJECT' (skips if it already exists)..."

PROJECT_EXISTS=$(northflank get project --project "$NF_PROJECT" --output json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null || echo "")

if [[ -z "$PROJECT_EXISTS" ]]; then
    northflank create project --input "{\"name\":\"$NF_PROJECT\",\"description\":\"Claude Code Discord launcher daemon\"}"
    success "Project '$NF_PROJECT' created."
else
    info "Project '$NF_PROJECT' already exists."
fi

# Re-read project ID
PROJECT_ID=$(northflank get project --project "$NF_PROJECT" --output json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null || true)
[[ -n "$PROJECT_ID" ]] || die "Could not get project ID after creation."

# ── CREATE SECRET GROUP ───────────────────────────────────────────────────────
info "Creating secret group '$NF_SECRET_GROUP' with LAUNCHER_WS_URL + PROXY_TOKEN ..."

SECRET_SPEC=$(python3 - << PYEOF
import json
spec = {
    "name": "$NF_SECRET_GROUP",
    "description": "Claude launcher daemon secrets",
    "secretType": "environment",
    "priority": 10,
    "secrets": {
        "LAUNCHER_WS_URL":      {"value": "$WS_URL"},
        "PROXY_TOKEN":          {"value": "$PROXY_TOKEN"},
        "ANTHROPIC_API_KEY":    {"value": "$ANTHROPIC_API_KEY"},
        "ANTHROPIC_AUTH_TOKEN": {"value": "$PROXY_TOKEN"}
    }
}
print(json.dumps(spec))
PYEOF
)

# Try create; if it already exists, update instead
northflank create secret \
    --project "$PROJECT_ID" \
    --input "$SECRET_SPEC" 2>/dev/null || \
northflank update secret \
    --project "$PROJECT_ID" \
    --secret "$NF_SECRET_GROUP" \
    --input "$SECRET_SPEC" 2>/dev/null || \
warn "Could not create/update secret group — set secrets manually in the Northflank dashboard."

# ── CREATE DEPLOYMENT SERVICE ─────────────────────────────────────────────────
info "Creating deployment service '$NF_SERVICE' ..."

SERVICE_SPEC=$(python3 - << PYEOF
import json
spec = {
    "name": "$NF_SERVICE",
    "description": "Claude Code Discord launcher daemon (LAUNCHER_TARGET=northflank)",
    "billing": {"deploymentPlan": "nf-compute-10"},
    "deployment": {
        "type": "deployment",
        "instances": 1,
        "external": {"imagePath": "$IMAGE_REF"},
        "docker": {"configType": "default"}
    },
    "runtimeEnvironment": {
        "LAUNCHER_TARGET":   "northflank",
        "LAUNCHER_BACKGROUND": "1",
        "CPROXY_SCRIPT":     "/app/claude-proxy.sh"
    },
    "runtimeSecrets": [
        {"secretName": "$NF_SECRET_GROUP", "secretPath": "/"}
    ]
}
print(json.dumps(spec))
PYEOF
)

northflank create service \
    --project "$PROJECT_ID" \
    --input "$SERVICE_SPEC" 2>/dev/null || \
warn "Service may already exist. Check the Northflank dashboard."

echo ""
success "Northflank deployment complete."
echo ""
echo "  Service : $NF_SERVICE"
echo "  Project : $NF_PROJECT"
echo "  Image   : $IMAGE_REF"
echo ""
echo "  Useful commands:"
echo "    Logs:    ./scripts/northflank/setup.sh --logs"
echo "    Status:  ./scripts/northflank/setup.sh --status"
echo "    Update:  ./scripts/northflank/setup.sh --image $IMAGE_NAME --update"
echo "    Delete:  ./scripts/northflank/setup.sh --delete"
echo ""
echo "  Dashboard: https://app.northflank.com"
echo ""
echo "  ⚠️  One-time: authenticate Claude Code inside the container."
echo "     Open a shell via the Northflank dashboard → Exec tab, then run:"
echo "       claude   (log in with your Anthropic account)"
echo "     Or pre-bake the auth token into a Northflank secret:"
echo "       ANTHROPIC_AUTH_TOKEN=\$(cat ~/.claude/.credentials.json | base64)"
echo "     Then add ANTHROPIC_AUTH_TOKEN to the '$NF_SECRET_GROUP' secret group."
echo ""
