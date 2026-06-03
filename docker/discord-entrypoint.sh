#!/usr/bin/env bash
# discord-entrypoint.sh — Configure Claude Code + Discord plugin, then launch.
#
# This entrypoint does three things:
#   1. Writes access.json from env vars — no pairing flow needed for containers
#   2. Configures Claude Code to recognise the bundled plugin via enabledPlugins
#      (NOT mcpServers — enabledPlugins signals "channel plugin" and keeps
#      Claude alive waiting for Discord messages rather than requiring a prompt)
#   3. Launches `claude` — Discord plugin starts as its MCP subprocess and
#      connects to the Discord gateway
#
# Required env vars:
#   DISCORD_BOT_TOKEN        Your bot's token from Discord Developer Portal
#   WORKER_URL               Deployed Cloudflare Worker URL (the AI proxy)
#
# Optional env vars:
#   PROXY_TOKEN              Worker auth token (default: dev-token)
#   DISCORD_ALLOWED_CHANNEL  Channel ID this session serves (recommended)
#   DISCORD_ALLOWED_USERS    Comma-separated Discord user ID snowflakes
#   DISCORD_REQUIRE_MENTION  "true" to require @mention in guild channels
#   DISCORD_DEBUG_WEBHOOK_URL  Webhook URL for plugin debug logs
#   DISCORD_STATE_DIR        Plugin state dir (default: /root/.claude/channels/discord)

set -euo pipefail

# ── Validate required env vars ────────────────────────────────────────────────

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
    echo "" >&2
    echo "  ERROR: DISCORD_BOT_TOKEN is not set." >&2
    echo "  Pass it at runtime: docker run -e DISCORD_BOT_TOKEN=MTIz... ..." >&2
    echo "" >&2
    exit 1
fi

if [[ -z "${WORKER_URL:-}" ]]; then
    echo "" >&2
    echo "  ERROR: WORKER_URL is not set." >&2
    echo "  Pass it at runtime: docker run -e WORKER_URL=https://... ..." >&2
    echo "" >&2
    exit 1
fi

WORKER_URL="${WORKER_URL%/}"
PROXY_TOKEN="${PROXY_TOKEN:-dev-token}"
STATE_DIR="${DISCORD_STATE_DIR:-/root/.claude/channels/discord}"

# ── Create plugin state directory ─────────────────────────────────────────────
mkdir -p "$STATE_DIR"

# ── Build allowFrom JSON array from DISCORD_ALLOWED_USERS ────────────────────

ALLOW_FROM_JSON="[]"
if [[ -n "${DISCORD_ALLOWED_USERS:-}" ]]; then
    ALLOW_FROM_JSON=$(
        echo "${DISCORD_ALLOWED_USERS}" \
        | tr ',' '\n' \
        | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
        | grep -v '^$' \
        | awk 'BEGIN{printf "["} NR>1{printf ","} {printf "\"%s\"", $0} END{printf "]"}'
    )
fi

REQUIRE_MENTION="false"
[[ "${DISCORD_REQUIRE_MENTION:-false}" == "true" ]] && REQUIRE_MENTION="true"

# ── Write access.json ─────────────────────────────────────────────────────────
# DISCORD_ACCESS_MODE=static (set on exec below) tells the plugin to read this
# once at boot and never mutate it — safe for single-channel containers.

if [[ -n "${DISCORD_ALLOWED_CHANNEL:-}" ]]; then
    GROUPS_JSON=$(cat << EOF
{
    "${DISCORD_ALLOWED_CHANNEL}": {
      "requireMention": ${REQUIRE_MENTION},
      "allowFrom": ${ALLOW_FROM_JSON}
    }
  }
EOF
)
else
    GROUPS_JSON="{}"
fi

cat > "${STATE_DIR}/access.json" << EOF
{
  "dmPolicy": "allowlist",
  "allowFrom": ${ALLOW_FROM_JSON},
  "groups": ${GROUPS_JSON},
  "pending": {}
}
EOF
chmod 0600 "${STATE_DIR}/access.json"

# ── Register plugin via Claude Code's plugin system ───────────────────────────
# Claude Code distinguishes between:
#   mcpServers   — generic MCP processes, no special mode triggered
#   enabledPlugins — first-class channel plugins, keeps Claude in listening
#                    mode waiting for Discord messages instead of requiring a prompt
#
# We point installPath directly at /app/plugin/ (already has node_modules
# baked in from the Dockerfile RUN bun install step).

mkdir -p /root/.claude/plugins

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
cat > /root/.claude/plugins/installed_plugins.json << EOF
{
  "version": 2,
  "plugins": {
    "discord@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "/app/plugin",
        "version": "0.0.4",
        "installedAt": "${NOW}",
        "lastUpdated": "${NOW}"
      }
    ]
  }
}
EOF

mkdir -p /root/.claude
cat > /root/.claude/settings.json << 'SETTINGS_EOF'
{
  "theme": "dark",
  "enabledPlugins": {
    "discord@claude-plugins-official": true
  },
  "permissions": {
    "allow": [
      "mcp__plugin_discord_discord__reply",
      "mcp__plugin_discord_discord__react",
      "mcp__plugin_discord_discord__edit_message",
      "mcp__plugin_discord_discord__fetch_messages",
      "mcp__plugin_discord_discord__download_attachment",
      "mcp__plugin_discord_discord__ask"
    ]
  }
}
SETTINGS_EOF

# ── Print startup banner ──────────────────────────────────────────────────────

echo ""
echo "  ╔══════════════════════════════════════════════════════════════════╗"
echo "  ║  Claude Code — Discord Session                                  ║"
printf "  ║  Proxy:   %-54s║\n" "$WORKER_URL"

if [[ -n "${DISCORD_ALLOWED_CHANNEL:-}" ]]; then
    printf "  ║  Channel: %-54s║\n" "id:${DISCORD_ALLOWED_CHANNEL}"
else
    printf "  ║  Channel: %-54s║\n" "(all channels)"
fi

USER_COUNT=$(echo "${ALLOW_FROM_JSON}" | grep -o '"' | wc -l | awk '{print $1/2}')
printf "  ║  Users:   %-54s║\n" "${USER_COUNT} allowed"
echo "  ╚══════════════════════════════════════════════════════════════════╝"
echo ""

# ── Launch Claude Code via PTY wrapper ───────────────────────────────────────
# All DISCORD_* env vars are inherited by the plugin subprocess automatically.
# The -u flags prevent Vertex/Bedrock/AWS bypassing the Worker proxy.
#
# discord-autotheme.py wraps `claude` in a PTY so it thinks it has a real
# terminal (required for channel/plugin mode) and auto-answers the first-run
# theme selector with "Dark mode" so the container starts fully headless.
# After theme selection the wrapper becomes transparent — `docker attach` works
# for interactive use, and SIGTERM from `docker stop` is cleanly forwarded.

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
    DISCORD_STATE_DIR="$STATE_DIR" \
    DISCORD_ACCESS_MODE="static" \
    python3 /usr/local/bin/discord-autotheme.py "$@"
