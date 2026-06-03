#!/usr/bin/env bash
# sync-discord-plugin.sh — Push docker/discord-plugin/server.ts into the local
#                          Claude plugin cache so cproxy sessions and Docker
#                          builds both run the same code.
#
# docker/discord-plugin/server.ts is the single source of truth.
# Edit that file, then either:
#   - Run cproxy (auto-syncs before launch when discord plugin is in use)
#   - Or run this script manually, then rebuild the Docker image:
#       ./scripts/sync-discord-plugin.sh
#       docker build -f docker/Dockerfile.claude-discord -t claude-discord .
#
# Source: docker/discord-plugin/server.ts
# Dest:   ~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="$REPO_ROOT/docker/discord-plugin/server.ts"
DST="$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts"

if [[ ! -f "$SRC" ]]; then
    echo "ERROR: Plugin source not found: $SRC" >&2
    exit 1
fi

if [[ ! -d "$(dirname "$DST")" ]]; then
    echo "Local plugin cache not found — Discord plugin may not be installed."
    echo "Install it first by running: claude --channels plugin:discord@claude-plugins-official"
    exit 1
fi

if cmp -s "$SRC" "$DST"; then
    echo "Plugin cache is already up to date."
else
    cp "$SRC" "$DST"
    echo "Synced: docker/discord-plugin/server.ts → plugin cache"
fi
