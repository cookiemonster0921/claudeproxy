# Claude Code Discord Channel Container

This folder is a standalone Docker version of:

```bash
cproxy on prod --channels plugin:discord@claude-plugins-official
```

The container does not invoke `cproxy`. It applies the equivalent production
proxy environment, registers the bundled Discord plugin, and starts:

```bash
claude --channels plugin:discord@claude-plugins-official
```

Claude runs inside `tmux`, which keeps a PTY alive when Docker runs detached.

## Configuration

Add these values to the repository root `.dev.vars`:

```bash
WORKER_URL=https://your-worker.workers.dev
PROXY_TOKEN=your-worker-token
DISCORD_BOT_TOKEN=your-discord-bot-token
ANTHROPIC_API_KEY=your-console-api-key
```

Channels require Anthropic authentication even though model requests are
routed through the Worker. This image uses an Anthropic Console API key from
`ANTHROPIC_API_KEY`. It does not use Claude subscription OAuth or browser
authentication. Do not use the Worker's `PROXY_TOKEN` as the Anthropic API key.

The container sends `PROXY_TOKEN` to the Worker as the separate
`x-proxy-token` header. This avoids an authentication conflict when
`ANTHROPIC_API_KEY` is set for Console authentication.

The entrypoint seeds Claude Code's local API-key approval metadata so the
interactive session starts without a browser authorization flow.

Optionally configure the model and Discord access non-interactively:

```bash
CLAUDE_MODEL=google_ai/gemini-2.5-flash
DISCORD_CHANNEL_IDS=1510193804525961326
DISCORD_USER_IDS=750640430416265267
DISCORD_DM_POLICY=allowlist
DISCORD_REQUIRE_MENTION=false
```

`DISCORD_CHANNEL_IDS` and `DISCORD_USER_IDS` accept comma-separated Discord
numeric IDs. When channel IDs are supplied, the configured channel list is
replaced at startup. `DISCORD_REQUIRE_MENTION` defaults to `false` for
configured channels. Set it to `true` to process only mentions and replies.

## Start

From this folder:

```bash
docker compose up --build -d
```

To override the model and Discord access for one launch from the repository
root:

```bash
CLAUDE_MODEL=google_ai/gemini-2.5-flash \
DISCORD_CHANNEL_IDS=1510193804525961326 \
DISCORD_USER_IDS=750640430416265267 \
DISCORD_DM_POLICY=allowlist \
docker compose -f chatgpt-version/compose.yaml up --build -d --force-recreate
```

Attach to the Claude Code terminal:

```bash
docker exec -it claude-discord-chatgpt-version tmux attach -t claude-discord
```

In Docker Desktop, open the container's Exec tab and run:

```bash
tmux attach -t claude-discord
```

Detach without stopping Claude by pressing `Ctrl-B`, then `D`.

## Stop

```bash
docker compose down
```

Claude settings, transcripts, onboarding, and Discord access state persist in
the `claude-discord-state` Docker volume. Remove that volume only when you
intentionally want to reset the container's Claude home and pairing state.

## Edit The Plugin

The editable plugin snapshot is under `plugin/`. Rebuild after editing:

```bash
docker compose up --build -d
```

To replace the snapshot with the currently installed host plugin:

```bash
./sync-plugin.sh
docker compose up --build -d
```
