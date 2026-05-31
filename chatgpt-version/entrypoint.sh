#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="discord@claude-plugins-official"
PLUGIN_DIR="/app/plugin"
TMUX_SESSION="${TMUX_SESSION:-claude-discord}"
CHANNEL="${CLAUDE_CHANNEL:-plugin:${PLUGIN_ID}}"

if [[ -z "${WORKER_URL:-}" ]]; then
    echo "ERROR: WORKER_URL is required." >&2
    exit 1
fi

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
    echo "ERROR: DISCORD_BOT_TOKEN is required." >&2
    exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "ERROR: ANTHROPIC_API_KEY is required for Claude Console authentication." >&2
    echo "Set ANTHROPIC_API_KEY in .dev.vars." >&2
    exit 1
fi

export ANTHROPIC_BASE_URL="${WORKER_URL%/}"
# Keep Worker authentication separate from Claude account authentication.
# ANTHROPIC_AUTH_TOKEN takes precedence over ANTHROPIC_API_KEY in Claude Code.
if [[ -n "${ANTHROPIC_CUSTOM_HEADERS:-}" ]]; then
    export ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS}"$'\n'"x-proxy-token: ${PROXY_TOKEN:-dev-token}"
else
    export ANTHROPIC_CUSTOM_HEADERS="x-proxy-token: ${PROXY_TOKEN:-dev-token}"
fi
unset ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"

# Match cproxy on prod: prevent a host-provided cloud backend from bypassing the Worker.
unset CLAUDE_CODE_USE_VERTEX
unset ANTHROPIC_VERTEX_PROJECT_ID
unset ANTHROPIC_VERTEX_BASE_URL
unset CLOUD_ML_REGION
unset CLAUDE_CODE_USE_BEDROCK
unset ANTHROPIC_BEDROCK_BASE_URL
unset CLAUDE_CODE_USE_ANTHROPIC_AWS
unset ANTHROPIC_AWS_BASE_URL

mkdir -p \
    /etc/claude-code/managed-settings.d \
    /root/.claude/plugins \
    /root/.claude/channels/discord

# Apply optional non-interactive Discord access settings before the plugin
# starts. These mirror the useful cproxy flags for unattended containers.
bun -e '
const path = "/root/.claude/channels/discord/access.json";
let config = { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} };
try {
  config = { ...config, ...JSON.parse(await Bun.file(path).text()) };
} catch {}

const parseIds = (name) => {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const ids = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`${name} must contain comma-separated Discord numeric IDs`);
  }
  return ids;
};

const userIds = parseIds("DISCORD_USER_IDS");
const channelIds = parseIds("DISCORD_CHANNEL_IDS");
const dmPolicy = process.env.DISCORD_DM_POLICY?.trim();
const requireMentionRaw = process.env.DISCORD_REQUIRE_MENTION?.trim().toLowerCase();

if (dmPolicy) {
  if (!["pairing", "allowlist", "disabled"].includes(dmPolicy)) {
    throw new Error("DISCORD_DM_POLICY must be pairing, allowlist, or disabled");
  }
  config.dmPolicy = dmPolicy;
}

if (userIds) {
  config.allowFrom = userIds;
  config.pending = Object.fromEntries(
    Object.entries(config.pending ?? {}).filter(([, pending]) => !userIds.includes(pending.senderId)),
  );
}

if (channelIds) {
  const requireMention = requireMentionRaw
    ? ["1", "true", "yes"].includes(requireMentionRaw)
    : false;
  config.groups = Object.fromEntries(channelIds.map((channelId) => [
    channelId,
    { requireMention, allowFrom: userIds ?? config.groups[channelId]?.allowFrom ?? [] },
  ]));
} else if (userIds) {
  for (const policy of Object.values(config.groups)) policy.allowFrom = userIds;
}

await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
'

# Claude Code prompts once before using an API key in interactive mode. Seed
# only the approval metadata so container startup never enters browser OAuth.
bun -e '
const path = "/root/.claude.json";
let config = {};
try {
  config = JSON.parse(await Bun.file(path).text());
} catch {}
const suffix = process.env.ANTHROPIC_API_KEY.slice(-20);
config.hasCompletedOnboarding = true;
config.customApiKeyResponses ??= {};
config.customApiKeyResponses.approved = [
  ...new Set([...(config.customApiKeyResponses.approved ?? []), suffix]),
];
config.customApiKeyResponses.rejected =
  (config.customApiKeyResponses.rejected ?? []).filter((value) => value !== suffix);
await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
'

# Claude Code channels are policy-gated, even for the official Discord plugin.
cat > /etc/claude-code/managed-settings.d/discord-channels.json <<EOF
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    {
      "marketplace": "claude-plugins-official",
      "plugin": "discord"
    }
  ]
}
EOF

# Register the bundled plugin under the same ID used by the host command.
cat > /root/.claude/plugins/installed_plugins.json <<EOF
{
  "version": 2,
  "plugins": {
    "${PLUGIN_ID}": [
      {
        "scope": "user",
        "installPath": "${PLUGIN_DIR}",
        "version": "0.0.4",
        "installedAt": "2026-01-01T00:00:00.000Z",
        "lastUpdated": "2026-01-01T00:00:00.000Z"
      }
    ]
  }
}
EOF

# Keep the bundled channel plugin enabled while leaving settings easy to edit.
cat > /root/.claude/settings.json <<EOF
{
  "theme": "dark",
  "enabledPlugins": {
    "${PLUGIN_ID}": true
  }
}
EOF

claude_args=(--channels "$CHANNEL")
if [[ -n "${CLAUDE_MODEL:-}" ]]; then
    claude_args+=(--model "$CLAUDE_MODEL")
fi
claude_args+=("$@")

printf -v claude_command '%q ' claude "${claude_args[@]}"

echo "Starting: ${claude_command}"
echo "Proxy:    ${ANTHROPIC_BASE_URL}"
echo "Attach:   tmux attach -t ${TMUX_SESSION}"

# tmux owns the PTY, so Claude stays interactive when the container is detached.
tmux new-session -d -s "$TMUX_SESSION" "$claude_command"

# A fresh Claude home has three known setup dialogs. Answer only those dialogs;
# once onboarding is persisted this loop exits without sending any keys.
bootstrap_claude() {
    local screen
    for _ in $(seq 1 150); do
        tmux has-session -t "$TMUX_SESSION" 2>/dev/null || return
        screen="$(tmux capture-pane -p -t "$TMUX_SESSION")"
        case "$screen" in
            *"Detected a custom API key in your environment"*)
                tmux send-keys -t "$TMUX_SESSION" Up Enter
                sleep 1
                ;;
            *"Select login method:"*)
                echo "ERROR: Claude Code unexpectedly requested browser login." >&2
                return
                ;;
            *"Choose the text style"*|*"Press Enter to continue"*|*"Yes, I trust this folder"*)
                tmux send-keys -t "$TMUX_SESSION" Enter
                sleep 1
                ;;
            *"Listening for channel messages from:"*)
                echo "Discord channel is listening."
                return
                ;;
            *"--channels ignored"*)
                echo "ERROR: Claude Code ignored the channel plugin." >&2
                return
                ;;
            *)
                sleep 0.2
                ;;
        esac
    done
}
bootstrap_claude &

cleanup() {
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
    sleep 1
done
