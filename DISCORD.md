# Discord Control Plane — Complete Guide

The Discord integration is a full AI control plane built on top of the Claude proxy.
Every Discord channel is an independent session. Slash commands drive the proxy
directly — no terminal needed.

---

## Table of Contents

1. [Architecture overview](#architecture-overview)
2. [What the proxy is (and isn't)](#what-the-proxy-is-and-isnt)
3. [Setup from scratch](#setup-from-scratch)
4. [Running locally](#running-locally)
5. [All slash commands](#all-slash-commands)
6. [Three ways to run agentic tasks](#three-ways-to-run-agentic-tasks)
7. [Session continuation](#session-continuation)
8. [Example workflows](#example-workflows)
9. [Provider routing cheat-sheet](#provider-routing-cheat-sheet)
10. [Secrets and env vars reference](#secrets-and-env-vars-reference)

---

## Architecture overview

```
You (Discord) ──► Discord Gateway
                       │
                       ▼
              Cloudflare Worker (claude-proxy)
              ┌─────────────────────────────────────────┐
              │  POST /discord/interactions              │
              │         │                               │
              │  Discord signature verify               │
              │         │                               │
              │  commandRouter.ts                       │
              │    /ask, /plan, /review …               │
              │         │                               │
              │  ProxyService ──► Provider              │
              │                  (Workers AI /          │
              │                   OpenRouter /          │
              │                   NVIDIA NIM /          │
              │                   Google Gemini)        │
              │                                         │
              │  GoalAgent (Durable Object)             │
              │    per-channel, persists state          │
              │         │                               │
              │  GoalWorkflow (Cloudflare Workflow)     │
              │    durable agentic loop                 │
              └─────────────────────────────────────────┘
                       │
              ┌────────┴────────┐
              │                 │
   Google Cloud Run         Discord Bot API
   Container (claude CLI)   (async notifications)
```

### How Discord delivers commands

Discord sends a `POST /discord/interactions` webhook. The Worker has **3 seconds**
to reply with the initial response, then posts follow-up messages via the Discord
Bot API for anything that takes longer (all AI calls).

---

## What the proxy is (and isn't)

| | Proxy Worker (`/ask` etc.) | Local `claude` CLI | `/cloudrun` | `/agent` |
|---|---|---|---|---|
| Runs LLM inference | ✅ via provider | ✅ real Claude | ✅ real Claude | ✅ via proxy |
| Bash / file tools | ❌ | ✅ | ✅ | ❌ |
| Needs a local machine | ❌ | ✅ always | ❌ | ❌ |
| Session persists if laptop closes | ✅ | ❌ | ✅ | ✅ |
| MCP servers | ❌ | ✅ | ✅ Val Town | ✅ Val Town API |

**The proxy does NOT run `claude` locally.** `/ask`, `/plan`, and all conversational
commands call an LLM provider directly (Workers AI, OpenRouter, Gemini, etc.).
They are NOT the same as running the `claude` CLI.

For real `claude` CLI behaviour from Discord, use `/cloudrun` or `/agent`.

---

## Setup from scratch

### 1. Deploy the proxy

```bash
npm install
npx wrangler login

# Create D1 database (one-time — copy the database_id into wrangler.jsonc)
npm run db:create

# Run all migrations
npm run db:migrate:local  && npm run db:migrate:remote
npm run db:migrate2:local && npm run db:migrate2:remote
npm run db:migrate3:local && npm run db:migrate3:remote
npm run db:migrate4:local && npm run db:migrate4:remote
npm run db:migrate5:local && npm run db:migrate5:remote
npm run db:migrate6:local && npm run db:migrate6:remote   # cloud session continuation

npm run deploy
```

### 2. Create the Discord application

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. **Bot** tab → **Reset Token** → copy the Bot Token
3. **General Information** → copy **Application ID** and **Public Key**
4. **Bot** tab → enable **Message Content Intent**
5. **OAuth2 → URL Generator** → scopes: `bot` + `applications.commands` →
   permissions: `Send Messages`, `Read Message History` → invite the bot to your server

### 3. Add env vars

Edit `.dev.vars` for local dev. For production use `wrangler secret put <KEY>`.

```bash
# Discord (required)
DISCORD_PUBLIC_KEY=<from General Information>
DISCORD_APPLICATION_ID=<your app ID>
DISCORD_BOT_TOKEN=<your bot token>

# LLM provider — pick one or set per-tier
MODEL=openrouter/anthropic/claude-sonnet-4-5
OPENROUTER_API_KEY=sk-or-v1-...

# Google Gemini (optional)
GOOGLE_AI_API_KEY=AIza...

# Cloud Run agent (optional — see "Three ways to run agentic tasks")
CLOUD_RUN_URL=https://claude-agent-xxxx-uc.a.run.app
CONTAINER_SECRET=some-random-secret

# Cloudflare Workflow agent tools (optional)
VALTOWN_API_KEY=vt_...
GITHUB_TOKEN=ghp_...        # optional, for private repos
```

### 4. Set Interactions Endpoint URL

In the Discord Developer Portal → **General Information** → **Interactions Endpoint URL**:

```
https://your-worker.workers.dev/discord/interactions
```

> **Local dev:** Discord cannot reach `localhost`. Use a tunnel:
> ```bash
> cloudflared tunnel --url http://localhost:8787
> # or
> npx localtunnel --port 8787
> ```
> Paste the tunnel URL as the Interactions Endpoint URL.

### 5. Register slash commands

```bash
npm run discord:register
# Reads credentials from .dev.vars automatically — no env vars needed on command line
```

---

## Running locally

```bash
# Terminal 1 — start the proxy
npm run dev
# → listening on http://localhost:8787

# Terminal 2 — point Claude Code at the local proxy (optional)
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_AUTH_TOKEN=any-value
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

Or use the `cproxy` launcher (install once with `./install.sh`):

```bash
cproxy on              # interactive provider picker + starts claude
cproxy on openrouter   # skip picker, use OpenRouter
cproxy on google_ai    # skip picker, use Gemini
cproxy off             # stop proxy, revert to real Anthropic API
cproxy status          # show proxy status
cproxy log             # live coloured request log
```

---

## All slash commands

### Conversation

| Command | Description |
|---|---|
| `/ask <message>` | Send a message — full conversation history per channel |
| `/compact [instructions]` | Summarise and replace conversation history |
| `/context` | Show estimated token usage |
| `/export [format]` | Export conversation as Markdown or plain text |

### Session management

| Command | Description |
|---|---|
| `/status` | Show current model, effort, goal, message count |
| `/model <model>` | Set the LLM model for this channel |
| `/effort <level>` | Set depth: `low` / `medium` / `high` / `xhigh` / `max` / `auto` |
| `/goal <text>` | Set a persistent objective prepended to every system prompt |
| `/help` | List all commands |

### AI workflows (one-shot, uses conversation context)

| Command | Description |
|---|---|
| `/plan [description]` | Generate a step-by-step implementation plan |
| `/review [target]` | General code or architecture review |
| `/code-review [target]` | Structured review: critical / style / performance |
| `/security-review [target]` | OWASP-focused security review |
| `/qa` | Identify unverified assumptions, missing tests, edge cases |
| `/verify <claim>` | Ask Claude to verify a specific claim |
| `/recap` | Summarise session in 3–5 bullet points |
| `/insights` | Proxy analytics: requests, cost, latency, model breakdown |
| `/loop <prompt> [max_iterations]` | Repeat a prompt N times (max 10) |

### Admin commands *(require admin role)*

| Command | Description |
|---|---|
| `/agents` | Provider availability and routing info |
| `/mcp` | MCP server configuration |
| `/memory` | Session memory and storage usage |
| `/debug` | Full session state and settings resolution |
| `/batch <prompt>` | Run prompt against multiple models side-by-side |
| `/run <workflow> [target]` | Run a named workflow: `plan` / `review` / `code-review` / `security-review` / `qa` / `recap` |
| `/updateconfig <key> <value>` | Update `model`, `effort`, or `goal` for this channel |

### Cloud agents *(require admin role)*

| Command | Description |
|---|---|
| `/cloudrun <goal> [model]` | Run goal with **real `claude` CLI** in a Cloud Run container |
| `/agent <goal>` | Run goal with the **Cloudflare cloud agent** (no local machine) |
| `/agentstop` | Stop the running cloud agent in this channel |
| `/agentclear` | Clear cloud agent conversation history (next `/agent` starts fresh) |

---

## Three ways to run agentic tasks

### Option 1 — Local Claude Code → proxy

Your `claude` CLI runs locally; the proxy is just its API backend.

```
[Your machine]
  claude CLI  ──► ANTHROPIC_BASE_URL=https://proxy.workers.dev
                                    │
                             [Proxy Worker]
                                    │
                             LLM provider (OpenRouter / Gemini / etc.)
```

**When to use:** You're at your laptop. You want full Claude Code — bash, file tools,
MCP servers, real model. The proxy provides routing, cost logging, and model switching.

```bash
cproxy on openrouter
```

---

### Option 2 — `/cloudrun` (Google Cloud Run container)

A Docker container on Cloud Run runs the real `claude` CLI. Discord sends a goal,
the container executes the agentic loop, and posts results back to Discord
asynchronously.

```
Discord /cloudrun goal:…
        │
        ▼
  Proxy Worker ──► POST https://cloud-run-url/run  (202 immediately)
                              │
                    [Cloud Run container]
                       claude CLI subprocess
                         --output-format stream-json
                         --resume <session_id>   (if resuming)
                       ──► ANTHROPIC_BASE_URL=proxy
                       ──► MCP: Val Town (via settings.json)
                    captures session_id → stores in D1
                    posts output to Discord when done
```

**When to use:** Laptop is closed. You need real `claude` CLI — bash commands, file
tools, MCP, real model quality. Cloud Run scales to zero when idle.

**One-time setup:**

```bash
# Build and push container
docker build -t gcr.io/YOUR_PROJECT/claude-agent container/
docker push gcr.io/YOUR_PROJECT/claude-agent

# Deploy to Cloud Run
gcloud run deploy claude-agent \
  --image gcr.io/YOUR_PROJECT/claude-agent \
  --platform managed \
  --region us-central1 \
  --no-allow-unauthenticated \
  --set-env-vars "ANTHROPIC_BASE_URL=https://proxy.workers.dev,\
DISCORD_BOT_TOKEN=Bot.xxx,\
CONTAINER_SECRET=your-secret,\
VALTOWN_API_KEY=vt_xxx,\
ANTHROPIC_AUTH_TOKEN=your-proxy-token"

# Tell the proxy where the container lives
wrangler secret put CLOUD_RUN_URL      # https://claude-agent-xxxx-uc.a.run.app
wrangler secret put CONTAINER_SECRET
```

---

### Option 3 — `/agent` (Cloudflare Workflow, pure cloud)

A Durable Object (`GoalAgent`) orchestrates a `GoalWorkflow`. The workflow calls
the proxy for LLM inference and executes tools inside Cloudflare Workers — no
container, no local machine, zero idle cost.

```
Discord /agent goal:…
        │
        ▼
  Proxy Worker
    GoalAgent (DO, per channel) ──► creates GoalWorkflow
                                          │
                                  for each turn (max 30):
                                    ├── check stop signal
                                    ├── LLM call → ProxyService → provider
                                    └── execute tools:
                                        web_fetch / web_search
                                        valtown_create/run/edit/list/read
                                        http_request / github_read_file
                                          │
                                  posts progress every 5 turns
                                  posts result on completion
                                  saves full conversation to DO SQLite
```

**When to use:** Pure cloud tasks with no need for bash or local files. Best for:
building Val Town functions, web research, calling external APIs, GitHub exploration.

**Available tools:** `web_fetch`, `web_search`, `valtown_create_val`,
`valtown_run_val`, `valtown_edit_val`, `valtown_list_vals`, `valtown_read_val`,
`http_request`, `github_read_file`

**Setup** (bindings already in `wrangler.jsonc` — just add secrets):

```bash
wrangler secret put VALTOWN_API_KEY
wrangler secret put GITHUB_TOKEN   # optional
```

---

## Session continuation

Both cloud agent modes remember what happened and resume automatically.

### `/cloudrun` — two-tier resume

| Scenario | Behaviour |
|---|---|
| Same channel, **same container instance** | `--resume <session_id>` — exact Claude Code session |
| Same channel, **new container instance** (restart/cold start) | Fetches session ID + output summary from D1; uses `--resume` if possible, otherwise injects prior context into the goal |

The session ID is parsed from `--output-format stream-json` events and persisted to
D1 via the proxy's `/cloud-sessions` endpoint immediately after each run.

### `/agent` — full message-level continuation

When a workflow ends, all messages (last 40 = 20 turns) are saved to
`GoalAgentState.conversationJson` in Durable Object SQLite.

When `/agent` is called again in the same channel:
- Prior messages are retrieved from the agent state
- Prepended to the new conversation before the new goal is appended
- Discord shows `*(continuing — N prior turns in context)*`

**Reset history:** `/agentclear` clears stored messages. Next `/agent` starts fresh.

---

## Example workflows

### 1 — Quick question with follow-ups

```
/ask What's the difference between a mutex and a semaphore?

/ask Give me a Go example of each

/ask Now show me the same patterns in Rust using tokio

/compact     ← conversation getting long? compact it into a summary
```

---

### 2 — Plan then implement

```
/goal We are building a REST API in Go. Use the standard library only. No ORMs.

/plan description: Add rate limiting per IP address to all endpoints

/ask Here's what I have so far: [paste code]

/code-review

/security-review
```

---

### 3 — Build a Val Town function entirely in the cloud

No laptop. No terminal. Just Discord.

```
/agent goal: Create an HTTP val on Val Town called "hnDigest" that fetches the
top 5 Hacker News stories and returns them as JSON with title, url, and score.
Test it and confirm it returns valid JSON.
```

Agent creates the val, runs it, checks the output, fixes any errors, and posts the
val URL when done. Then continue:

```
/agent goal: Add a "limit" query parameter (1–10 stories, default 5) to the
hnDigest val. Update the tests.
```

Because prior turns are in context, the agent knows the val's ID and current code.

```
/agentclear   ← starting a completely different project? clear history first
```

---

### 4 — Agentic development session via Cloud Run

Requires Cloud Run container deployed.

```
/cloudrun goal: In the repo https://github.com/me/myapi, add JWT authentication
to the /users route. Write a test, make sure it passes, and push to a new branch
feat/jwt-auth.
```

Claude Code runs in the container with full bash and filesystem access. Progress
posts every 60 seconds. Final output (test results, branch URL) posts when done.

Continue the session:

```
/cloudrun goal: The CI is failing — fix the import paths in auth_test.go
```

If the container is still warm, `--resume <session_id>` picks up the exact session.
If it restarted, the prior summary is injected as context so Claude still knows
what it was working on.

---

### 5 — Code review sprint

```
/run code-review target: [paste diff or file]

/run security-review target: [paste the authentication code]

/verify claim: The JWT expiry check handles timezone differences correctly
```

---

### 6 — Multi-model A/B test

```
/batch prompt: Explain dependency injection in 3 bullet points
```

Runs against two models simultaneously. Useful for evaluating quality vs. speed.

---

### 7 — Persistent project goal

```
/goal This channel owns our data pipeline. All code is Python 3.12.
      We use Polars for dataframes (not pandas). Prioritise memory efficiency.

/ask Design the schema for storing streaming event data

/plan description: Add an incremental backfill command to the pipeline CLI

/qa   ← find edge cases and assumptions to verify
```

The goal is prepended to every system prompt in this channel until changed.

---

### 8 — Rotate provider mid-session

```
/status
→ Model: workers_ai

/model google_ai/gemini-2.5-flash
→ ✅ model → gemini-2.5-flash

/ask Summarise our conversation so far   ← Gemini handles this

/model openrouter/anthropic/claude-sonnet-4-5
→ ✅ model → claude-sonnet-4-5

/review   ← back to Claude for the code review
```

---

## Provider routing cheat-sheet

| `/model` value | Routes to | Credential |
|---|---|---|
| *(unset)* | Workers AI binding (llama 70B) | none |
| `claude-sonnet-4-6` | follows `MODEL` env var | depends |
| `openrouter/anthropic/claude-sonnet-4-5` | OpenRouter | `OPENROUTER_API_KEY` |
| `nvidia_nim/meta/llama-3.3-70b-instruct` | NVIDIA NIM | `NVIDIA_NIM_API_KEY` |
| `google_ai/gemini-2.5-flash` | Google AI Studio | `GOOGLE_AI_API_KEY` |
| `google_ai/gemini-2.5-pro` | Google AI Studio | `GOOGLE_AI_API_KEY` |
| `deepseek/deepseek-chat` | DeepSeek | `DEEPSEEK_API_KEY` |
| `cf-llama` | Workers AI llama 70B | none |
| `cf-qwen-coder` | Workers AI Qwen coder 32B | none |

Set defaults for all tiers in `.dev.vars`:

```bash
MODEL=openrouter/anthropic/claude-sonnet-4-5
MODEL_SONNET=openrouter/anthropic/claude-sonnet-4-5
MODEL_HAIKU=openrouter/anthropic/claude-haiku-4-5
MODEL_OPUS=openrouter/anthropic/claude-opus-4-5
```

---

## Secrets and env vars reference

### Discord

| Variable | Where | Description |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | `wrangler.jsonc` vars | Ed25519 key — verifies request signatures |
| `DISCORD_APPLICATION_ID` | `wrangler.jsonc` vars | Bot application ID |
| `DISCORD_BOT_TOKEN` | `.dev.vars` / secret | Bot token for sending messages |
| `DISCORD_ALLOWED_GUILD_IDS` | vars | Comma-separated guild IDs; empty = all |
| `DISCORD_ADMIN_ROLE_IDS` | vars | Role IDs for admin commands; empty = all |
| `DISCORD_ENABLE_ADMIN_COMMANDS` | vars | Default `true`; set `false` to disable |
| `DISCORD_STORE_MESSAGES` | vars | Default `false`; set `true` to persist message content in D1 |

### LLM providers

| Variable | Description |
|---|---|
| `MODEL` | Default: `workers_ai`. Format: `provider_id/model-name` |
| `MODEL_SONNET` / `MODEL_HAIKU` / `MODEL_OPUS` | Per-tier overrides |
| `OPENROUTER_API_KEY` | OpenRouter |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `GOOGLE_AI_API_KEY` | Google AI Studio / Gemini |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Workers AI REST API |

### Cloud agents

| Variable | Description |
|---|---|
| `CLOUD_RUN_URL` | Cloud Run container base URL |
| `CONTAINER_SECRET` | Bearer token for the container's HTTP API |
| `VALTOWN_API_KEY` | Val Town API key (used by `/agent` tool calls) |
| `GITHUB_TOKEN` | GitHub token for `github_read_file` tool |

### Misc

| Variable | Default | Description |
|---|---|---|
| `PROXY_TOKEN` | *(none)* | If set, all proxy API calls require `Authorization: Bearer <token>` |
| `IP_HASH_SECRET` | dev-local-salt | HMAC secret for hashing client IPs in analytics |
| `ANALYTICS_ENABLED` | `true` | Set `false` to disable D1 logging |
