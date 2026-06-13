#!/usr/bin/env bash
# sync-claude-settings.sh — Push local Claude Code settings to a remote VM.
#
# Syncs the user-level Claude config that makes the VM session feel identical
# to a local session: skills, plugins, commands, global memory, and settings.
#
# What is synced:
#   ~/.claude/settings.json      Global settings: permissions, plugins, MCPs,
#                                effortLevel, advisorModel, theme, etc.
#                                The "env" block is stripped — it may contain
#                                local-only Vertex/Bedrock vars that the VM
#                                doesn't need (claude-proxy.sh handles those).
#   ~/.claude/CLAUDE.md          Global memory / instructions
#   ~/.claude/skills/            Custom and installed skills
#   ~/.claude/commands/          Custom slash commands
#   ~/.claude/plugins/           Plugin metadata (installed_plugins.json, etc.)
#
# What is NOT synced:
#   ~/.claude/settings.local.json — has local absolute paths, not portable
#   ~/.claude/.credentials.json   — VM uses different auth (ANTHROPIC_AUTH_TOKEN)
#   ~/.claude/projects/           — project paths differ on the VM
#   ~/.claude/sessions/, history, cache, statsig, telemetry — runtime state
#
# Usage:
#   ./scripts/sync-claude-settings.sh SSH_USER HOST SSH_KEY_PATH
#
# Example:
#   ./scripts/sync-claude-settings.sh ubuntu 34.X.X.X ~/.ssh/id_ed25519
#
# Called automatically by setup-launcher.sh for GCE and Oracle.
# Also used by the macOS auto-sync LaunchAgent.

set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[sync]${RESET} $*"; }
success() { echo -e "${GREEN}[sync]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[sync]${RESET} $*"; }

SSH_USER="${1:-}"
HOST="${2:-}"
SSH_KEY="${3:-$HOME/.ssh/id_ed25519}"
[[ ! -f "$SSH_KEY" ]] && SSH_KEY="$HOME/.ssh/id_rsa"

[[ -n "$SSH_USER" ]] || { echo "Usage: $0 SSH_USER HOST [SSH_KEY_PATH]" >&2; exit 1; }
[[ -n "$HOST"     ]] || { echo "Usage: $0 SSH_USER HOST [SSH_KEY_PATH]" >&2; exit 1; }

CLAUDE_DIR="$HOME/.claude"
[[ -d "$CLAUDE_DIR" ]] || { warn "~/.claude not found — nothing to sync."; exit 0; }

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"

rsync_if_exists() {
    local src="$1"
    local dst="$2"
    local desc="$3"
    if [[ -e "$src" ]]; then
        rsync -az --delete \
            -e "ssh $SSH_OPTS" \
            "$src" "$SSH_USER@$HOST:$dst"
        info "  ✓ $desc"
    else
        info "  – $desc (not present locally, skipped)"
    fi
}

info "Syncing Claude settings → $SSH_USER@$HOST"

# ── Ensure remote ~/.claude exists ────────────────────────────────────────────
# shellcheck disable=SC2029
ssh $SSH_OPTS "$SSH_USER@$HOST" "mkdir -p ~/.claude"

# ── settings.json — strip the "env" block (local-only Vertex/Bedrock vars) ───
if [[ -f "$CLAUDE_DIR/settings.json" ]]; then
    # Strip the "env" block — it has local-only Vertex/Bedrock settings.
    # claude-proxy.sh explicitly unsets these vars, but leaving them in
    # settings.json on the VM would be misleading.
    CLEANED=$(python3 -c "
import json, sys
s = json.load(sys.stdin)
s.pop('env', None)
print(json.dumps(s, indent=2))
" < "$CLAUDE_DIR/settings.json" 2>/dev/null || cat "$CLAUDE_DIR/settings.json")
    echo "$CLEANED" | ssh $SSH_OPTS "$SSH_USER@$HOST" "cat > ~/.claude/settings.json"
    info "  ✓ settings.json (env block stripped)"
fi

# ── CLAUDE.md — global memory / instructions ──────────────────────────────────
rsync_if_exists "$CLAUDE_DIR/CLAUDE.md" "~/.claude/CLAUDE.md" "CLAUDE.md"

# ── skills/ — custom and installed skills ─────────────────────────────────────
rsync_if_exists "$CLAUDE_DIR/skills/" "~/.claude/skills/" "skills/"

# ── commands/ — custom slash commands ─────────────────────────────────────────
rsync_if_exists "$CLAUDE_DIR/commands/" "~/.claude/commands/" "commands/"

# ── plugins/ — plugin metadata (not the plugin cache, just the manifest) ──────
# Sync installed_plugins.json and known_marketplaces.json only.
# The actual plugin binaries are in cache/ which is large and platform-specific.
if [[ -d "$CLAUDE_DIR/plugins" ]]; then
    # shellcheck disable=SC2029
    ssh $SSH_OPTS "$SSH_USER@$HOST" "mkdir -p ~/.claude/plugins"
    for f in installed_plugins.json known_marketplaces.json blocklist.json; do
        if [[ -f "$CLAUDE_DIR/plugins/$f" ]]; then
            rsync -az -e "ssh $SSH_OPTS" \
                "$CLAUDE_DIR/plugins/$f" \
                "$SSH_USER@$HOST:~/.claude/plugins/$f"
            info "  ✓ plugins/$f"
        fi
    done
fi

# ── agents/ — custom agent definitions ───────────────────────────────────────
rsync_if_exists "$CLAUDE_DIR/agents/" "~/.claude/agents/" "agents/"

# ── Plugin cache — sync installed plugin SOURCE CODE (discord, fakechat, ...) ─
# installed_plugins.json records each plugin's installPath as an ABSOLUTE path
# on the LOCAL machine (e.g. /Users/you/.claude/plugins/cache/...). If we copy
# that file as-is, the path doesn't exist on the VM, so Claude Code treats the
# plugin as "not installed" and re-fetches the unmodified version from the
# marketplace — which for the Discord plugin only supports DMs, not channels,
# and doesn't match our edited docker/discord-plugin/server.ts.
#
# Fix: rsync each plugin's cache directory (source only — node_modules is
# excluded; `bun install` regenerates it via the plugin's `start` script) to
# the equivalent path under the VM's $HOME, and rewrite installed_plugins.json
# so installPath points there.
if [[ -f "$CLAUDE_DIR/plugins/installed_plugins.json" ]]; then
    REMOTE_HOME=$(ssh $SSH_OPTS "$SSH_USER@$HOST" 'echo $HOME')

    # Discord/fakechat plugins run via `bun run --cwd <plugin> start`.
    # shellcheck disable=SC2029
    # Symlinked into /usr/local/bin so it's on PATH for tmux/non-login shells
    # too (the launcher daemon runs sessions via `bash script.sh`, which
    # doesn't source ~/.bashrc).
    if ssh $SSH_OPTS "$SSH_USER@$HOST" 'command -v bun >/dev/null 2>&1' </dev/null; then
        info "  ✓ bun runtime present"
    else
        info "  ↳ installing bun runtime on VM..."
        # shellcheck disable=SC2016,SC2029
        ssh $SSH_OPTS "$SSH_USER@$HOST" '
            command -v unzip >/dev/null 2>&1 || sudo apt-get install -y --no-install-recommends unzip >/dev/null 2>&1
            curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
            grep -q ".bun/bin" ~/.bashrc 2>/dev/null || echo "export PATH=\$HOME/.bun/bin:\$PATH" >> ~/.bashrc
            grep -q ".bun/bin" ~/.profile 2>/dev/null || echo "export PATH=\$HOME/.bun/bin:\$PATH" >> ~/.profile
            sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
            command -v bun >/dev/null 2>&1
        ' </dev/null \
            && info "  ✓ bun installed" \
            || warn "  ✗ failed to install bun — plugin MCP servers (discord, fakechat) may not start"
    fi

    PAIRS_FILE="$(mktemp)"
    JSON_FILE="$(mktemp)"
    python3 - "$CLAUDE_DIR/plugins/installed_plugins.json" "$HOME" "$REMOTE_HOME" "$JSON_FILE" "$PAIRS_FILE" << 'PYEOF'
import json, sys
local_file, local_home, remote_home, json_out, pairs_out = sys.argv[1:6]
data = json.load(open(local_file))
pairs = []
for entries in data.get("plugins", {}).values():
    for entry in entries:
        p = entry.get("installPath", "")
        if p.startswith(local_home):
            remote_p = remote_home + p[len(local_home):]
            pairs.append((p, remote_p))
            entry["installPath"] = remote_p
json.dump(data, open(json_out, "w"), indent=2)
with open(pairs_out, "w") as f:
    for local_p, remote_p in pairs:
        f.write(f"{local_p}\t{remote_p}\n")
PYEOF

    while IFS=$'\t' read -r local_path remote_path; do
        [[ -d "$local_path" ]] || continue
        # </dev/null on ssh/rsync: without it, these inherit the while loop's
        # stdin (the pairs file) and consume the remaining lines after the
        # first iteration.
        # shellcheck disable=SC2029
        ssh $SSH_OPTS "$SSH_USER@$HOST" "mkdir -p '$remote_path'" </dev/null
        rsync -az --delete \
            --exclude='node_modules/' \
            --exclude='.in_use' \
            -e "ssh $SSH_OPTS" \
            "$local_path/" "$SSH_USER@$HOST:$remote_path/" </dev/null
        info "  ✓ plugin cache: ${local_path#"$HOME/.claude/plugins/cache/"}"
    done < "$PAIRS_FILE"

    cat "$JSON_FILE" | ssh $SSH_OPTS "$SSH_USER@$HOST" "cat > ~/.claude/plugins/installed_plugins.json"
    info "  ✓ installed_plugins.json (installPath rewritten for VM \$HOME)"
    rm -f "$PAIRS_FILE" "$JSON_FILE"
fi

# ── Post-sync: ensure plugins are installed on the VM ─────────────────────────
# After syncing installed_plugins.json, the VM knows which plugins should be
# installed, but the plugin binaries themselves are missing (we skipped cache/).
# Running `claude --channels <plugins>` installs them on first use, OR we can
# trigger a background install here.
ENABLED_PLUGINS=$(python3 -c "
import json, sys
try:
    s = json.load(open('$CLAUDE_DIR/settings.json'))
    plugins = [k for k, v in s.get('enabledPlugins', {}).items() if v]
    if plugins:
        print(','.join(plugins))
except:
    pass
" 2>/dev/null || true)

if [[ -n "$ENABLED_PLUGINS" ]]; then
    info "  ↳ Pre-installing plugins on VM: $ENABLED_PLUGINS"
    # shellcheck disable=SC2029
    ssh $SSH_OPTS "$SSH_USER@$HOST" \
        "cd ~/claude-proxy && claude --channels '$ENABLED_PLUGINS' --print 'ping' 2>/dev/null | head -1 || true" &
    PLUGIN_PID=$!
    # Don't wait — runs in background, just fires off the install
    disown $PLUGIN_PID 2>/dev/null || true
fi

success "Claude settings synced to $HOST"
