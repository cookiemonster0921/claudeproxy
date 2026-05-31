#!/usr/bin/env bash
# sync-discord-plugin.sh — Copy the live Discord plugin into the Docker build context.
#
# Run this after editing the plugin, then rebuild the image:
#   ./scripts/sync-discord-plugin.sh && docker build -f docker/Dockerfile.claude-discord -t claude-discord .
#
# Source: ~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts
# Dest:   docker/discord-plugin/server.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts"
DST="$REPO_ROOT/docker/discord-plugin/server.ts"

if [[ ! -f "$SRC" ]]; then
    echo "ERROR: Plugin source not found: $SRC" >&2
    exit 1
fi

if cmp -s "$SRC" "$DST"; then
    echo "Plugin is already up to date."
else
    cp "$SRC" "$DST"
    echo "Synced: $SRC → $DST"
    echo ""
    echo "Rebuild the image to apply the changes:"
    echo "  docker build -f docker/Dockerfile.claude-discord -t claude-discord ."
    echo "  # or for Cloud Run:"
    echo "  ./scripts/spawn-discord-session.sh --build --project YOUR_PROJECT"
fi
