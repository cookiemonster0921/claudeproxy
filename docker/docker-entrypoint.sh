#!/usr/bin/env bash
# docker-entrypoint.sh — mirrors `cproxy on prod` inside the container.
#
# Required env var (set with docker run -e):
#   WORKER_URL    Deployed Cloudflare Worker URL, e.g. https://claude-proxy.xxx.workers.dev
#
# Optional env var:
#   PROXY_TOKEN   Secret that the Worker validates; defaults to "dev-token"
#                 (the Worker's default when no PROXY_TOKEN secret is configured)
set -euo pipefail

# Abort early with a clear message if the Worker URL is missing — without it
# every request would fall through to the real Anthropic API, bypassing the proxy.
if [[ -z "${WORKER_URL:-}" ]]; then
    echo "" >&2
    echo "  ERROR: WORKER_URL is not set." >&2
    echo "  Pass it at runtime:  docker run -e WORKER_URL=https://... ..." >&2
    echo "" >&2
    exit 1
fi

# Strip trailing slash so URL concatenation inside the Worker stays clean.
WORKER_URL="${WORKER_URL%/}"

# Fall back to "dev-token" — matches the Worker's default when PROXY_TOKEN
# secret is not configured on the deployed Worker.
PROXY_TOKEN="${PROXY_TOKEN:-dev-token}"

echo ""
echo "  ╔══════════════════════════════════════════════════════════════════╗"
echo "  ║  Backend: PRODUCTION (claude-proxy Cloudflare Worker)           ║"
printf "  ║  URL:     %-54s║\n" "$WORKER_URL"
echo "  ║  Routing follows the Worker's deployed MODEL secret.            ║"
echo "  ╚══════════════════════════════════════════════════════════════════╝"
echo ""

# exec replaces this shell with the `claude` process — clean PID 1,
# proper SIGTERM/SIGINT forwarding, no zombie shell hanging around.
#
# The -u flags unset every Vertex / Bedrock / AWS env var so Claude Code
# cannot bypass the Worker and call those backends directly (same as
# claude-proxy.sh lines 526-537 in the prod branch).
#
# ANTHROPIC_BASE_URL          → all API calls go to the Worker instead of api.anthropic.com
# ANTHROPIC_AUTH_TOKEN        → Worker validates this against its PROXY_TOKEN secret
# CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY → lets the CLI accept non-Anthropic model IDs
#                               returned by the Worker (e.g. openrouter/..., nvidia_nim/...)
exec env \
    -u CLAUDE_CODE_USE_VERTEX \
    -u ANTHROPIC_VERTEX_PROJECT_ID \
    -u ANTHROPIC_VERTEX_BASE_URL \
    -u CLOUD_ML_REGION \
    -u CLAUDE_CODE_USE_BEDROCK \
    -u ANTHROPIC_BEDROCK_BASE_URL \
    -u CLAUDE_CODE_USE_ANTHROPIC_AWS \
    -u ANTHROPIC_AWS_BASE_URL \
    ANTHROPIC_BASE_URL="$WORKER_URL" \
    ANTHROPIC_AUTH_TOKEN="$PROXY_TOKEN" \
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1" \
    claude "$@"
