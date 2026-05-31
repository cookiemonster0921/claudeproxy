# Discord Control Plane — How It Works

The Discord integration turns your proxy into a remotely-operable AI assistant. Discord slash commands are the control surface: each channel holds an independent Claude session, and commands like `/ask`, `/plan`, and `/review` drive the proxy directly from Discord without touching a terminal.

---

## What you need before starting

- The proxy deployed (locally or on Cloudflare) — see [GUIDE.md](GUIDE.md)
- A **Discord application** with a bot — [discord.com/developers/applications](https://discord.com/developers/applications)
- The **D1 database** set up (required for sessions) — see the Analytics section of [GUIDE.md](GUIDE.md)
- Node.js 18+ for running the command registration script

---

## Connecting your Discord bot

### 1. Create the application

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create a new application
2. Go to **Bot** → copy the **Bot Token**
3. Go to **General Information** → copy the **Application ID** and **Public Key**

### 2. Set the Interactions Endpoint URL

In **General Information → Interactions Endpoint URL**, enter:

```
https://your-worker.workers.dev/discord/interactions
```

(or `http://localhost:8787/discord/interactions` for local dev — Discord can't reach localhost directly, so use a tunnel like `cloudflared tunnel` or `ngrok` for testing)

### 3. Add env vars

In `.dev.vars` (local) or as Wrangler secrets (deployed):

```bash
DISCORD_PUBLIC_KEY=abc123...        # from General Information — verifies request signatures
DISCORD_APPLICATION_ID=123456789   # your bot's application/user ID
DISCORD_BOT_TOKEN=Bot.abc123...    # only used to register slash commands
```

Optional access controls:

```bash
DISCORD_ALLOWED_GUILD_IDS=111,222  # comma-separated; empty = all servers allowed
DISCORD_ADMIN_ROLE_IDS=333,444     # comma-separated role IDs; empty = everyone is admin
DISCORD_ENABLE_ADMIN_COMMANDS=true # set to 'false' to disable admin-only commands
DISCORD_STORE_MESSAGES=false       # set to 'true' to persist full message content in D1
```

### 4. Register slash commands

Run this once to register all commands with Discord:

```bash
npx tsx scripts/register-discord-commands.ts
```

This reads `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID` from `.dev.vars` and registers the full command list. Commands take a few minutes to propagate globally.

### 5. Invite the bot to your server

In the Developer Portal, go to **OAuth2 → URL Generator**:
- Scopes: `bot`, `applications.commands`
- Bot permissions: `Send Messages`, `Use Slash Commands`, `Read Message History`

Open the generated URL in a browser to invite the bot.

---

## How sessions work

Each Discord **channel** is its own session. When you send a command in a channel, the proxy:

1. Looks up (or creates) a session record in D1 for that channel ID
2. Loads the last 20 messages from conversation history
3. Resolves model and effort settings
4. Calls the AI and stores the result

**Threads** work the same way — each thread ID is a separate session. This lets you run parallel sub-tasks in threads off a main channel.

### Settings resolution order

When deciding which model or effort level to use, the proxy checks in this order (first set value wins):

```
explicit override → session override (/model, /effort) → project default → DEFAULT_MODEL env var → MODEL env var → claude-sonnet-4-6
```

So `/model` in a channel overrides the server default, and a project's `defaultModel` sits between the two.

### Effort levels

Effort controls `max_tokens` and the system prompt injected into every AI call:

| Level | Max tokens | System prompt addition |
|---|---|---|
| `low` | 512 | "Be concise. Minimal explanation." |
| `medium` | 1024 | *(none)* |
| `high` | 2048 | "Think step by step. Be thorough and detailed." |
| `xhigh` | 4096 | "Think step by step. Be thorough and detailed. Consider edge cases." |
| `max` | 8192 | "Think step by step. Be exhaustive, thorough, and detailed. Cover all edge cases and alternatives." |
| `auto` | 4096 | *(none)* |

---

## Slash commands

### Core — no AI call

| Command | What it does |
|---|---|
| `/status` | Shows session state: model, effort, goal, message count, proxy health |
| `/context` | Token usage estimate for the last 20 messages |
| `/model <model>` | Sets the model for this channel (overrides env default) |
| `/effort <level>` | Sets effort level: `low` / `medium` / `high` / `xhigh` / `max` / `auto` |
| `/goal <text>` | Sets a persistent goal — appended to every system prompt until overwritten |
| `/export [format]` | Exports conversation history as `txt` or `md` (truncated at ~1800 chars) |
| `/help` | Lists all available commands |

### Core — AI calls

| Command | What it does |
|---|---|
| `/ask <message>` | Sends a message to Claude. Loads history, appends your message, stores the reply. |
| `/compact [instructions]` | Summarizes the last 50 messages into a compact note, then clears history |
| `/plan <description>` | Runs a multi-step planning workflow for the described task |
| `/review [target]` | General architecture or code review |
| `/code-review <target>` | Structured code review with findings |
| `/security-review <target>` | Security-focused review |
| `/recap` | Bullet-point summary of the last 30 messages |
| `/qa` | QA analysis of the current session |
| `/verify <claim>` | Asks Claude to evaluate whether a claim is correct |
| `/loop <prompt> [max_iterations]` | Runs the same prompt up to 10 times in sequence; stops early if session is set to `stopped` |
| `/insights` | Analytics summary: request counts, cost, latency, top models, top Discord commands |

### Admin — role-restricted

Admin commands require the caller to hold a role listed in `DISCORD_ADMIN_ROLE_IDS`. If that env var is unset, all users are treated as admins.

| Command | What it does |
|---|---|
| `/agents` | Shows which providers are configured (Workers AI, OpenRouter, NVIDIA NIM, etc.) |
| `/mcp` | Explains MCP configuration (MCP runs in the Claude Code client, not the proxy) |
| `/memory` | Shows D1 storage state: message count, privacy mode, DB connection |
| `/debug` | Dumps raw session, project, and resolved settings as JSON |
| `/batch <prompt>` | Sends the same prompt to `claude-sonnet-4-6` and `claude-haiku-4-5` in parallel, shows both responses |
| `/run <workflow> [target]` | Runs a named workflow directly: `plan`, `review`, `code-review`, `security-review`, `qa`, `recap` |
| `/run-skill-generator <description>` | Generates a workflow definition for a described task |
| `/updateconfig <key> <value>` | Sets `model`, `effort`, or `goal` for the current channel (same as the shorthand commands) |
| `/team-onboarding` | Prints a welcome guide for new team members |
| `/fewer-permission-prompts` | Explains that permission prompts are controlled by the Claude Code client, not the proxy |

---

## How /ask works step by step

```
User sends /ask "explain the rate limiter"
          │
          ▼
  Discord sends POST /discord/interactions
          │
          ▼
  1. Verify Ed25519 signature (DISCORD_PUBLIC_KEY)
  2. Check guild allowlist
  3. Check rate limits (user: 10/min, channel: 30/min, guild: 100/min)
  4. Return 202 DeferredChannelMessage immediately (avoids 3-second Discord timeout)
          │
          ▼  (runs in ctx.waitUntil)
  5. Load session + conversation history from D1
  6. Resolve model and effort settings
  7. Build messages array: [history…, { role: "user", content: prompt }]
  8. Call ProxyService.handleMessages (internal — no HTTP round-trip)
  9. Store user message + assistant reply in D1 conversation history
 10. Log analytics row to D1
 11. Edit the deferred message with the response text + action buttons
```

---

## Button actions

After every AI response, the proxy attaches a row of clickable buttons:

| Button | Action |
|---|---|
| ▶️ Continue | Sends "Continue." as a new /ask message |
| 🔄 Retry | Re-sends the last user message |
| 💪 Stronger | Upgrades model (haiku → sonnet, sonnet/opus → opus-4-7) and continues |
| ℹ️ Status | Runs /status inline |
| 📝 Recap | Runs /recap inline |

The `/loop` command also shows a ⏹️ Stop button that sets the session status to `stopped`, which halts the loop at the next iteration check.

Button interactions are also deferred — Discord gets an immediate 202 and the action runs in `ctx.waitUntil`.

---

## Security model

### Signature verification

Every request to `/discord/interactions` is verified against `DISCORD_PUBLIC_KEY` using Ed25519. Invalid signatures get a 401 before any code runs.

### Guild allowlist

If `DISCORD_ALLOWED_GUILD_IDS` is set, commands from servers not in the list are rejected with a visible error. Leave it unset to allow all servers.

### Admin role gating

Commands in the admin set (listed above) check the caller's guild roles against `DISCORD_ADMIN_ROLE_IDS`. If the env var is unset, admin commands are open to everyone. To lock them down, set the env var to a comma-separated list of Discord role IDs.

To disable admin commands entirely:

```bash
DISCORD_ENABLE_ADMIN_COMMANDS=false
```

### Bot filtering

Interactions from bot users are silently ignored (204 response) to prevent bot-to-bot loops.

---

## Rate limiting

Limits are enforced in memory (per Worker instance) using a sliding-window algorithm:

| Scope | Limit |
|---|---|
| Per user | 10 commands / minute |
| Per channel | 30 commands / minute |
| Per guild | 100 commands / minute |

These reset on Worker restart. They are not shared across multiple Worker instances in production, so treat them as best-effort throttling rather than hard enforcement.

---

## Message storage and privacy

By default, **message content is not stored**. The conversation store only persists metadata: role, a length indicator, and timestamp. The `content` column is empty.

To store full message content (required for `/recap`, `/compact`, and history-aware `/ask`):

```bash
DISCORD_STORE_MESSAGES=true
```

With this set, user messages and assistant replies are stored verbatim in the D1 `conversation_history` table.

**What is never stored regardless of this setting:** API keys, auth headers, provider credentials.

---

## Workflows

Multi-step commands (`/plan`, `/review`, `/code-review`, `/security-review`, `/recap`, `/compact`, `/qa`) use a workflow runner that chains multiple AI calls:

```
workflowRunner.runWorkflow(env, steps, model, maxTokens)
  │
  ├─ step 1: system_prompt + user_prompt → Claude → output
  ├─ step 2: previous output injected into next prompt → Claude → output
  └─ step N: ... → final output returned to Discord
```

Each workflow is defined as an array of `{ label, system_prompt, user_prompt }` steps in `src/workflows/workflowRunner.ts`. The output of each step is available to the next via `{{previous_output}}` substitution.

---

## File reference

| File | Purpose |
|---|---|
| `src/discord/interactions.ts` | Main entry point — signature verification, dispatch, deferred response |
| `src/discord/commandRouter.ts` | Maps command names to handlers, enforces admin gating |
| `src/discord/commands.ts` | All command handler functions |
| `src/discord/followups.ts` | Message chunking, button rows, followup editing |
| `src/discord/permissions.ts` | Guild allowlist, admin role check, bot filter |
| `src/discord/rateLimit.ts` | In-memory sliding-window rate limiter |
| `src/discord/discordApi.ts` | Thin wrappers around Discord REST API calls |
| `src/discord/discordTypes.ts` | TypeScript types for Discord interaction payloads |
| `src/discord/verifySignature.ts` | Ed25519 signature verification |
| `src/sessions/sessionStore.ts` | D1-backed session CRUD (model override, effort, goal, status) |
| `src/sessions/conversationStore.ts` | D1-backed message history (add, get, clear, count, export) |
| `src/sessions/settingsResolver.ts` | Merges env → project → session → override into final settings |
| `src/projects/projectSettings.ts` | Per-project defaults (model, system prompt, repo URL) stored in D1 |
| `src/workflows/workflowRunner.ts` | Multi-step chained AI call runner |
| `scripts/register-discord-commands.ts` | Registers slash commands with Discord's API |

---

## Quick reference

```
/ask <message>               Chat with Claude, maintains history
/status                      Show session info
/model <model>               Set model for this channel
/effort <level>              Set effort: low/medium/high/xhigh/max/auto
/goal <text>                 Set a persistent goal
/context                     Show token usage stats
/compact [instructions]      Summarize and clear history
/plan <description>          Generate a plan
/review [target]             General review
/code-review <target>        Structured code review
/security-review <target>    Security-focused review
/recap                       Bullet-point session summary
/qa                          QA analysis of this session
/verify <claim>              Fact-check a claim
/loop <prompt> [n]           Run a prompt n times (max 10)
/insights                    Analytics dashboard
/export [txt|md]             Export conversation transcript
/help                        Command list

-- Admin --
/agents                      Provider status
/debug                       Raw session + settings dump
/batch <prompt>              Same prompt to multiple models
/run <workflow> [target]     Run a named workflow
/memory                      Storage and privacy state
/updateconfig <key> <value>  Set model/effort/goal via key-value
```
