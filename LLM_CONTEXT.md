# claude-proxy — LLM Architecture & Context Document

**For:** AI assistant sessions that need full technical context on this project without reading all source files.  
**Last updated:** 2026-06-05  
**Project root:** `/Users/shujiang/Documents/claude-proxy`  
**Cloudflare Worker URL:** `https://claude-proxy.vjiang888.workers.dev`

---

## 1. What This Project Is

`claude-proxy` is a Cloudflare Worker that serves as a multi-provider LLM API proxy with a full Discord control plane. It is primarily a **personal productivity tool** — a way to operate Claude Code and other LLMs from Discord channels, both as a conversational AI assistant and as an orchestration layer that can launch real Claude Code sessions on local or cloud machines.

The project has two distinct personas running behind the same Worker:

- **Main Discord bot** — conversational AI that reads and replies in Discord channels, backed by D1 conversation history. Handles slash commands like `/ask`, `/plan`, `/review`.
- **Ops Discord bot** — an operator control surface. Slash commands like `/local` and `/computeengine` launch actual Claude Code processes on machines, not just LLM calls.

---

## 2. Core Architectural Layers

### Layer 1: Cloudflare Worker (the centre of everything)

The Worker handles all inbound HTTP traffic. It has no concept of "running AI" itself — it routes LLM API calls to upstream providers, manages Discord webhook interactions, and acts as the relay for the local daemon system.

Key routing:
- `/v1/*` — LLM proxy (transforms requests to upstream provider format and streams responses back)
- `/discord/interactions` — main bot slash commands
- `/discord/ops/interactions` — ops bot slash commands
- `/launcher-ws` — WebSocket upgrade to `LauncherDO` (for the local daemon)
- `/launcher-dispatch` — HTTP trigger for daemon dispatch (CLI/test path)
- `/launcher-status` — daemon connection status

The Worker enforces Ed25519 signature verification for every Discord interaction before processing. The ops bot uses a **separate public key** (`OPS_BOT_PUBLIC_KEY`) from the main bot (`DISCORD_PUBLIC_KEY`).

### Layer 2: LLM Provider Routing

`model-router.ts` dispatches incoming model strings to the correct provider adapter. Supported providers and their routing prefixes:

| Prefix | Provider | Notes |
|---|---|---|
| `google/` or `gemini/` | Google AI (Gemini) | Native streaming, thinking blocks |
| `openrouter/` | OpenRouter | OpenAI-compatible |
| `nvidia/` | NVIDIA NIM | OpenAI-compatible |
| `@cf/` | Cloudflare Workers AI | Native CF AI binding |
| (none / `claude-`) | Anthropic via Workers AI | Fallback |

The Gemini provider has its own transform layer because Gemini's API is structurally different from OpenAI-compatible APIs. All other providers use the `openai-compat` base adapter.

### Layer 3: Durable Objects (stateful compute)

Two DOs are registered. Both use `new_sqlite_classes` (required on Cloudflare's free plan — using `new_classes` causes a deploy error):

**GoalAgent** — per-channel agentic loop. Each Discord channel that invokes `/agent` gets a named DO instance. Stores goal state, conversation context, and runs multi-step reasoning using tool calls. Backed by SQLite storage. Also runs a `GoalWorkflow` (Cloudflare Workflow) for durable async steps.

**LauncherDO** — WebSocket relay for the local daemon system. Accepts incoming WebSocket connections from `discord_session_launcher.py` running on a local machine. When the ops bot wants to launch a Claude Code session, it dispatches a JSON frame through this DO to all connected daemons.

**Critical design requirement for LauncherDO:** Must use the **Hibernatable WebSocket API** (`ctx.acceptWebSocket()` / `ctx.getWebSockets()`), not the standard WebSocket API. Cloudflare puts DOs to sleep when idle. Standard WebSockets stored in an in-memory Set are destroyed on hibernation — every time the DO wakes up, `getWebSockets()` returns empty and the system reports "0 daemons connected" even when a daemon is active. The Hibernatable API persists WebSocket state across hibernation cycles.

### Layer 4: D1 Database (conversation history)

All Discord message sessions are stored in D1. Tables: sessions (channel → session mapping), messages (full conversation history per session, optional), analytics (usage metrics). The session store supports up to 20-message rolling context windows.

---

## 3. The Discord Control Plane (Two Bots)

### Main Bot

Registered slash commands: `/ask`, `/plan`, `/review`, `/code`, `/agent`, `/analyze`, `/session`, `/model`, `/cloudrun`, and admin commands.

The main bot calls LLM providers directly from the Worker. It does NOT run Claude Code. All responses are pure LLM API calls with D1-backed session context. Responses over Discord's 2000-character limit are split or sent as file attachments.

The `/agent` command is special: it instantiates a `GoalAgent` DO that runs an agentic loop with tool use (currently Val Town API as external tool surface). This is the closest the main bot gets to autonomous task execution.

The `/cloudrun` command launches a **Docker container** on Google Cloud Run containing the real `claude` CLI with a Discord MCP plugin. This is the only main-bot command that results in a real Claude Code process running.

### Ops Bot (separate Discord application)

A second Discord application with its own token and public key. This bot's sole purpose is to launch and manage Claude Code sessions on infrastructure. It never converses — it dispatches.

Current slash commands:
- `/local` — **fully wired** — launches a Claude Code session via the local daemon
- `/computeengine` — **UI stub only** — shows the flow but does nothing
- `/cloudshell` — **UI stub only**
- `/cloudrunjobs` — **UI stub only**

The `/local` command flow:
1. User picks a model (dropdown)
2. User picks which Discord users the session should serve (multi-select)
3. A config is stored in `LauncherDO` with an 8-character hex token (10-minute TTL)
4. Confirm/Cancel buttons shown to the operator
5. Confirm click → Worker dispatches to daemon → daemon opens a Claude Code session

---

## 4. The Local Daemon System

`discord_session_launcher.py` is a Python WebSocket daemon that runs on the operator's local machine. It connects outbound to the Cloudflare Worker's `/launcher-ws` endpoint, which forwards to `LauncherDO`.

When a dispatch frame arrives (`{ command, session_id, mode }`), the daemon launches a Claude Code process in one of two modes:

**Terminal (GUI) mode:** Opens the process in a new terminal tab/window. On macOS uses AppleScript with a temp shell script (not inline `do script` quoting — double quotes and line continuations in the command string break AppleScript's parser). Detects iTerm2 vs Terminal.app. On Linux tries gnome-terminal → konsole → xterm. On Windows uses WSL + Windows Terminal with Git Bash fallback.

**Background (silent) mode:** Launches the process in a detached `tmux` session. The PTY must be preserved — do NOT pipe stdout through `tee` or any other pipe, as this causes `isatty()` to return false, which makes Claude Code fall back to non-interactive `--print` mode and error out. Log capture is done separately via `tmux pipe-pane` with an ANSI-stripping `sed` command (BSD sed requires `printf '\033'` not `\x1b` for the escape character). Falls back to `screen` then `script` if tmux unavailable. On Windows uses WSL with `DETACHED_PROCESS | CREATE_NO_WINDOW` flags.

The daemon authenticates to the Worker using `Bearer <PROXY_TOKEN>` on the WebSocket upgrade. Config is read from `.dev.vars` or environment variables. Reconnection uses exponential backoff (1s → 60s, 2× multiplier).

---

## 5. The Discord Plugin (Claude Code ↔ Discord bridge)

When a Claude Code session is launched (by the daemon or by cloud infrastructure), it uses a **Discord MCP plugin** to communicate. The plugin source of truth is `docker/discord-plugin/server.ts`. It is a Node.js MCP server that:

- Connects to the Discord gateway using Discord.js
- Exposes Discord messages to Claude Code as XML-tagged input (`<channel source="discord" chat_id="..." ...>`)
- Provides a `reply(chat_id, text)` MCP tool that Claude calls to send responses
- Provides `ask(chat_id, question, options)` for interactive picker prompts in Discord
- Provides `fetch_messages`, `react`, `edit_message`, `download_attachment`

The plugin is synced from `docker/discord-plugin/` to the local Claude plugin cache on every `claude-proxy.sh` launch via `scripts/sync-discord-plugin.sh`. This ensures the same code runs locally and in containers.

**Critical instruction ordering:** The plugin's system instructions must place the reply tool mandate as the very first rule. LLMs weight early context more heavily. When the reply rule was buried after paragraphs of context, models (especially Gemini) frequently failed to call `reply`, leaving users with no response. The current ordering: reply mandate → message format → tool descriptions → example sequences.

---

## 6. Cloud Deployment Options

### Option A: Google Cloud Run (primary cloud path)

`scripts/gcp-deploy-discord-cloud-run-service.sh` deploys a container built from `docker/Dockerfile.claude-discord` to Cloud Run. The container runs the Discord plugin process connected to a Claude Code session. Container name is deterministic per channel: `discord-session-<channel_id>`. State volume `discord-state-<channel_id>` persists `.claude/` across restarts.

`scripts/gcp-deploy-discord-cloud-run-job.sh` uses Cloud Run Jobs for one-shot batch tasks instead of persistent services.

### Option B: Google Compute Engine

`scripts/gcp-deploy-discord-compute-engine.sh` is a **CLI-only standalone tool** — it is NOT wired to Discord commands. Must be run from a terminal. It provisions or reuses a GCE VM and launches a Docker container session on it. Same container image as Cloud Run.

### Option C: Google Cloud Shell

`scripts/gcp-run-discord-cloud-shell.sh` launches a session inside Cloud Shell. Intended for ephemeral sessions without provisioning VMs. Also CLI-only.

### Option D: Oracle Cloud Infrastructure (OCI)

`scripts/oracle/provision-vm.sh` creates an ARM A1.Flex VM on OCI (4 OCPU, 24 GB RAM) using the Always Free tier. `scripts/oracle/deploy-session.sh` manages container sessions on that VM. Same Docker image as GCP options.

### Option E: Local (via daemon)

The daemon path described in Section 4. The Claude Code process runs on the operator's laptop with full filesystem and tool access. Depends on the daemon being connected to `LauncherDO`.

---

## 7. Session Management — Current State and Gaps

### What exists

The Worker stores Discord conversation history in D1, scoped by channel ID. The main bot uses this for context continuity across conversations.

For cloud sessions (Cloud Run, GCE, Oracle), container naming is deterministic by channel ID. Stopping and restarting a container for the same channel picks up the same Claude project history via named volumes.

### What is missing (critical gap for local sessions)

The local daemon has **no session registry**. There is no mapping from Discord channel ID to a running tmux session or process. This means:

- Running `/local` twice for the same channel creates two competing Claude Code instances, both connected to the Discord plugin, both responding to messages. Users get duplicate or racing replies.
- When a local session is restarted, Claude Code starts in the daemon's working directory (not a channel-scoped directory), so project history context is not automatically preserved.
- There is no way for the ops bot to detect whether a local session is already running before launching another.

**Intended design (not yet implemented):** A registry file at `~/.claude/discord-sessions/registry.json` mapping channel ID to `{ tmux_session_name, pid, work_dir, started_at }`. Before launch, the daemon checks if an alive session exists for that channel. Channel-scoped work directories at `~/.claude/discord-sessions/<channel_id>/` would give Claude Code consistent project history. The ops bot would offer Resume / New session options when a live session is detected.

---

## 8. Multi-Channel Architecture — Fundamental Constraint

The single most important architectural constraint to understand: **one Discord bot token supports exactly one active gateway connection**.

The Discord plugin process calls `client.login(TOKEN)` to open a Discord.js gateway connection. If two processes use the same token, Discord evicts the first when the second identifies, then Discord.js automatically reconnects the first, which evicts the second — an endless `INVALID_SESSION` war. Neither instance is stable.

This means the current architecture supports **exactly one running Claude Code session per bot token**, regardless of how many channels it theoretically filters for.

Docker containers have isolated filesystems so they don't share state files, but they still share the bot token. The same eviction war happens across containers.

**There are two correct solutions:**

1. **Separate Discord application per channel** — each channel gets its own bot token. Zero code changes needed. Operationally tedious if scaled beyond a handful of channels, but completely correct and the recommended path for the current codebase.

2. **Router process architecture** — a single Discord.js process holds the one gateway connection, routes inbound messages to the correct Claude Code instance via IPC (Unix socket, HTTP, stdin/stdout), and proxies outbound `reply()` calls. This is architecturally clean for many channels but requires pulling Discord.js out of the MCP plugin entirely — a significant redesign. The MCP tool surface would need to be replaced with an IPC transport.

---

## 9. Known Issues and Bugs

### Gemini Flash 2.5 session failures

Claude Code sessions using Gemini 2.5 Flash (not Lite) show repeated retry messages (`✽ Fluttering… attempt N/10`). This is Claude Code retrying the LLM API call. The exact upstream error has not been captured — `wrangler tail --format pretty` needs to be running during an active session to see the Google AI API response. The most likely cause is the proxy's Gemini transform layer producing a request format that triggers a 400 or rate-limit error for multi-turn tool-use conversations. Recommended workaround: use OpenRouter with Claude Sonnet 4.5, which reliably follows the reply instruction.

### ANSI escape codes in background session logs

`tmux pipe-pane` captures raw PTY bytes, which include ANSI escape sequences (colours, cursor movements, terminal control codes). The ANSI stripping `sed` command may not catch all escape sequence variants across all session types, particularly thinking-block output and tool-use progress indicators. Logs may still contain garbled characters. This does not affect session functionality, only log readability.

### `access.json` shared state (local multi-instance)

All local MCP plugin instances on the same machine share `~/.claude/channels/discord/access.json`. This file stores the channel configuration written by `claude-proxy.sh`. There is no file locking. If two instances run concurrently, the last writer's channel configuration wins and the other instance may be misconfigured.

### Ops bot Interactions Endpoint URL

The ops bot's Interactions Endpoint URL in the Discord Developer Portal must be set to the deployed Worker URL, not a local tunnel. During development, if this is pointed at an ngrok or cloudflared URL, the production Discord interactions will fail silently (the Worker still returns the request body as-is because signature verification fails before any processing).

### TypeScript build strictness

The project uses strict TypeScript. `_` prefix is required for unused parameters in class method implementations (e.g., WebSocket handler parameters). Any `Promise<Response>` used where `Response` is expected causes a type error — `await` must be explicit on all async DO stub fetches.

---

## 10. Key Files and Their Roles

| File | Role |
|---|---|
| `src/index.ts` | Worker entry point and HTTP router |
| `src/proxy-service.ts` | Core LLM proxy logic |
| `src/model-router.ts` | Provider dispatch by model string prefix |
| `src/providers/gemini/` | Gemini-specific request/response transform |
| `src/providers/openai-compat.ts` | Base adapter for OpenAI-compatible providers |
| `src/discord/interactions.ts` | Main bot slash command handler |
| `src/discord/opsInteractions.ts` | Ops bot slash commands (including `/local` wiring) |
| `src/discord/commandRouter.ts` | Routes slash command names to handlers |
| `src/discord/sessionStore.ts` | D1-backed per-channel session state |
| `src/discord/modelSelector.ts` | Model picker dropdown component |
| `src/agent/GoalAgent.ts` | Per-channel agentic DO |
| `src/agent/GoalWorkflow.ts` | Durable Workflow for agentic tasks |
| `src/agent/LauncherDO.ts` | Hibernatable WS relay for daemon dispatch |
| `src/types.ts` | Env interface (all bindings declared here) |
| `wrangler.jsonc` | Worker config: routes, DO bindings, D1, migrations, vars |
| `discord_session_launcher.py` | Local daemon (Python, project root) |
| `docker/discord-plugin/server.ts` | MCP plugin source of truth (synced to cache at launch) |
| `scripts/sync-discord-plugin.sh` | Syncs plugin source to Claude's cache directory |
| `scripts/upload-secrets.sh` | Converts `.dev.vars` → Cloudflare secret bulk upload |
| `scripts/trigger-local-session.mts` | CLI test tool for daemon dispatch (bypasses Discord) |
| `scripts/register-discord-commands.mts` | Registers slash commands with Discord API |
| `scripts/gcp-deploy-discord-compute-engine.sh` | CLI tool: GCE VM session launch |
| `scripts/gcp-deploy-discord-cloud-run-service.sh` | CLI tool: Cloud Run container session |
| `scripts/oracle/provision-vm.sh` | OCI ARM VM provisioning |
| `scripts/oracle/deploy-session.sh` | OCI session container management |
| `claude-proxy.sh` | Local launch wrapper for `claude` with plugin wiring |

---

## 11. Environment Variables and Secrets

Variables marked **plain** live in `wrangler.jsonc` vars (committed). Variables marked **secret** must be in Cloudflare secrets (via `wrangler secret put` or `scripts/upload-secrets.sh`).

| Variable | Plain/Secret | Purpose |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | Plain | Ed25519 key for main bot signature verification |
| `DISCORD_APPLICATION_ID` | Plain | Main bot app ID |
| `OPS_BOT_PUBLIC_KEY` | Plain | Ed25519 key for ops bot signature verification |
| `DEFAULT_MODEL` | Plain | Default model string for main bot |
| `DISCORD_ALLOWED_GUILD_IDS` | Plain | Comma-separated guild ID allowlist (empty = all) |
| `DISCORD_ADMIN_ROLE_IDS` | Plain | Role IDs with admin command access |
| `DISCORD_STORE_MESSAGES` | Plain | Boolean: persist full message content in D1 |
| `DISCORD_BOT_TOKEN` | Secret | Main bot token for Discord REST API calls |
| `OPS_BOT_TOKEN` | Secret | Ops bot token |
| `PROXY_TOKEN` | Secret | Bearer auth for `/launcher-ws` and `/launcher-dispatch` |
| `ANTHROPIC_API_KEY` | Secret | If routing to Anthropic directly |
| `OPENROUTER_API_KEY` | Secret | OpenRouter routing |
| `GOOGLE_AI_API_KEY` | Secret | Google AI / Gemini routing |

Local-only vars in `.dev.vars` (not uploaded to Cloudflare secrets):
- `DISCORD_CHANNEL_IDS`, `DISCORD_USER_IDS`, `DISCORD_DM_POLICY`, `DISCORD_REQUIRE_MENTION` — runtime flags consumed by `claude-proxy.sh`
- `MODEL`, `CLAUDE_MODEL` — model override for local sessions
- `LAUNCHER_WS_URL`, `LAUNCHER_BACKGROUND`, `LAUNCHER_TERMINAL` — daemon configuration
- `CPROXY_SCRIPT` — absolute path to `claude-proxy.sh` for daemon use

---

## 12. Deployment Checklist

After any change to Worker TypeScript source:
- Run `npx wrangler deploy`
- The ops bot Interactions Endpoint URL must stay pointed at the deployed Worker URL in the Discord Developer Portal

After changes to `docker/discord-plugin/server.ts`:
- Local sessions: plugin is auto-synced on next `claude-proxy.sh` launch
- Cloud Run / Oracle: rebuild the Docker image and redeploy the container

After adding or changing secrets in `.dev.vars`:
- Run `scripts/upload-secrets.sh --apply` then `npx wrangler deploy`
- The `upload-secrets.sh` script skips keys already in `wrangler.jsonc` vars

After changing DO class code:
- Add a new migration tag in `wrangler.jsonc` migrations array using `new_sqlite_classes`
- `npx wrangler deploy` will apply the migration

---

## 13. Pending Work (Prioritised)

### P0 — Blocking for reliable multi-session use

**Local session registry** — implement channel ID → tmux session mapping with alive-check before launch, channel-scoped work directories, and Resume/New UI in Discord. Without this, `/local` cannot be used reliably by multiple people or across session restarts.

### P1 — Functional gaps

**Debug Gemini Flash failures** — capture the exact Google AI API error from `wrangler tail` during an active Gemini session. Fix is likely in the Gemini transform layer for multi-turn tool-use requests.

**Wire `/computeengine`, `/cloudshell`, `/cloudrunjobs`** — these are UI stubs. Wiring them requires: GCP service account credentials in Cloudflare secrets, Compute Engine / Cloud Run API calls from the Worker, and channel-to-resource mappings.

### P2 — Architecture improvements (router mode: Phase 1 complete)

**Multi-channel support — IMPLEMENTED (Phase 1)**. The `discord-router/` directory contains a Node.js router process that holds the single Discord.js gateway connection and relays messages to N plugin instances via WebSocket. Plugin instances connect with `DISCORD_ROUTER_URL` + `ROUTER_TOKEN` env vars instead of using their own Discord.js clients. Gateway war eliminated. See `ROUTER_DESIGN.md` for architecture and `scripts/start-router.sh` to run.

**Router mode — Phase 2 pending**: `requireMention` check currently skipped in router mode (access.json groups/allowFrom is enforced). DM routing not yet implemented for router mode. Cross-machine file attachments not supported.

**Oracle VM deployment of router** — router needs a public `wss://` endpoint (nginx/caddy + TLS) for Oracle VM instances to reach it. Run `docker build -t discord-router discord-router/` then deploy the container.

**Validate ANSI stripping in background logs** — confirm all escape sequence variants are caught by the `pipe-pane` sed pattern across different Claude Code output types (tool use, thinking, progress indicators).

### P3 — Nice to have

**Session health dashboard** — Discord command or web endpoint showing all active sessions (local tmux, Cloud Run containers, Oracle VMs) with uptime, channel association, and last-message timestamps.

**Automatic plugin re-sync** — currently `sync-discord-plugin.sh` runs only at `claude-proxy.sh` launch. Cloud containers use the image-baked version. A CI step or Makefile target that rebuilds images on plugin changes would prevent stale code running in cloud.
