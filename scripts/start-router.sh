#!/usr/bin/env bash
# start-router.sh — Start the discord-router process locally.
#
# The router holds the single Discord.js gateway connection and lets N Claude
# plugin instances share one bot token without INVALID_SESSION conflicts.
#
# Usage:
#   ./scripts/start-router.sh           — reads credentials from .dev.vars
#   ./scripts/start-router.sh --port 7777   — override WS port
#
# In .dev.vars, set:
#   DISCORD_BOT_TOKEN=Bot.abc...       — the Discord bot token
#   ROUTER_TOKEN=your-shared-secret    — shared secret for plugin auth
#   DISCORD_ROUTER_URL=ws://localhost:7777   — where plugins connect (for reference)
#
# For Oracle VM deployment:
#   Copy discord-router/ to the VM and run this script with the bot token and
#   router token as environment variables. Point DISCORD_ROUTER_URL in your
#   local .dev.vars to wss://your-oracle-vm-ip:7777 (with nginx/caddy for TLS).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ROUTER_DIR="$REPO_ROOT/discord-router"

# ── Read .dev.vars ────────────────────────────────────────────────────────────
DEV_VARS="$REPO_ROOT/.dev.vars"
if [[ -f "$DEV_VARS" ]]; then
    while IFS='=' read -r key val; do
        [[ -z "$key" || "$key" == \#* || -z "$val" ]] && continue
        val="${val%\"}"
        val="${val#\"}"
        val="${val%\'}"
        val="${val#\'}"
        export "$key"="$val"
    done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$DEV_VARS")
fi

# ── Validate required vars ────────────────────────────────────────────────────
if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
    echo "ERROR: DISCORD_BOT_TOKEN is not set (add it to .dev.vars or export it)" >&2
    exit 1
fi
if [[ -z "${ROUTER_TOKEN:-}" ]]; then
    echo "ERROR: ROUTER_TOKEN is not set (add it to .dev.vars or export it)" >&2
    exit 1
fi

WS_PORT="${ROUTER_WS_PORT:-7777}"
HTTP_PORT="${ROUTER_HTTP_PORT:-7778}"

echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║  Discord Router                                         ║"
echo "  ╠══════════════════════════════════════════════════════════╣"
printf "  ║  WebSocket port:  %-38s║\n" "$WS_PORT"
printf "  ║  Status port:     %-38s║\n" "$HTTP_PORT"
printf "  ║  Token (masked):  %-38s║\n" "${ROUTER_TOKEN:0:4}****"
echo "  ║                                                         ║"
echo "  ║  Plugin instances connect to:  ws://localhost:$WS_PORT       ║"
echo "  ║  Set in .dev.vars:  DISCORD_ROUTER_URL=ws://localhost:$WS_PORT║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Status: http://localhost:$HTTP_PORT/status"
echo ""

# ── Ensure dependencies installed ────────────────────────────────────────────
if [[ ! -d "$ROUTER_DIR/node_modules" ]]; then
    echo "  Installing router dependencies..."
    (cd "$ROUTER_DIR" && npm install --silent)
fi

# ── Start ─────────────────────────────────────────────────────────────────────
cd "$ROUTER_DIR"
exec npx tsx router.ts
