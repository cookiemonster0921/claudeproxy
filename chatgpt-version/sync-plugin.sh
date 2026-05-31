#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${DISCORD_PLUGIN_SRC:-$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4}"
DST="$SCRIPT_DIR/plugin"

if [[ ! -d "$SRC" ]]; then
    echo "ERROR: Discord plugin source not found: $SRC" >&2
    exit 1
fi

mkdir -p "$DST/.claude-plugin" "$DST/skills/access" "$DST/skills/configure"
cp "$SRC/server.ts" "$DST/server.ts"
cp "$SRC/package.json" "$DST/package.json"
cp "$SRC/bun.lock" "$DST/bun.lock"
cp "$SRC/.mcp.json" "$DST/.mcp.json"
cp "$SRC/.claude-plugin/plugin.json" "$DST/.claude-plugin/plugin.json"
cp "$SRC/skills/access/SKILL.md" "$DST/skills/access/SKILL.md"
cp "$SRC/skills/configure/SKILL.md" "$DST/skills/configure/SKILL.md"
cp "$SRC/ACCESS.md" "$DST/ACCESS.md"
cp "$SRC/README.md" "$DST/PLUGIN-README.md"

echo "Synced Discord plugin snapshot from: $SRC"
echo "Rebuild with: docker compose -f $SCRIPT_DIR/compose.yaml build"
