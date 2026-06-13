# Router Process Architecture Design

**Status:** Design only — no code changes made yet  
**Goal:** Allow N Claude Code instances to share one Discord bot token without the INVALID_SESSION gateway conflict  
**Date:** 2026-06-05

---

## 1. Problem Statement

Discord permits exactly one active gateway WebSocket connection per bot token per shard. The current plugin architecture embeds Discord.js inside each Claude Code MCP plugin process. When two plugin processes call `client.login(TOKEN)` simultaneously, Discord evicts the first when the second identifies on shard 0, Discord.js reconnects the first, which evicts the second — an endless session invalidation loop. Neither instance maintains a stable connection.

This is the root cause of all multi-instance, multi-channel failures. Separate bot tokens per channel is the zero-code workaround, but it scales poorly and requires managing N Discord applications. The router pattern solves it architecturally.

---

## 2. Core Design Principle

**Separate the Discord transport from the Claude plugin.**

Currently each plugin is responsible for:
1. Holding the Discord gateway connection (Discord.js client)
2. Receiving and filtering inbound messages
3. Formatting and sending outbound messages

The router process takes ownership of (1) and (2). The plugin retains only (3): Claude-facing MCP tool definitions and the formatting/routing of outbound calls back through the router. The plugin becomes a dumb relay client rather than an autonomous Discord participant.

---

## 3. Component Overview

```
Discord Gateway (WebSocket, 1 connection)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  DISCORD ROUTER  (Node.js, persistent process)              │
│                                                             │
│  ┌─────────────────┐    ┌──────────────────────────────┐   │
│  │ Discord.js client│    │ Instance Registry            │   │
│  │ (holds gateway) │    │ channel_id → instance_id     │   │
│  │                 │    │ instance_id → WS connection  │   │
│  │ messageCreate   │    │ instance_id → channel_list   │   │
│  │ interactionCreate│   │ instance_id → status         │   │
│  └────────┬────────┘    └──────────────────────────────┘   │
│           │                                                 │
│           ▼                                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ WebSocket server  (plugin instances connect here)   │   │
│  └─────────────────────────────────────────────────────┘   │
│           │                                                 │
│  ┌────────┴────────────────────────────────────────┐       │
│  │ HTTP API  (Cloudflare Worker posts here)        │       │
│  │ POST /interaction  ← button clicks, ask answers │       │
│  └─────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
        │ WebSocket connections (one per Claude instance)
        │
        ├── Plugin A  →  Claude Code instance A  (channel 111, local)
        ├── Plugin B  →  Claude Code instance B  (channel 222, local)
        ├── Plugin C  →  Claude Code instance C  (channel 333, Oracle VM 1)
        └── Plugin D  →  Claude Code instance D  (channel 444, Oracle VM 2)

Cloudflare Worker
  POST /discord/interactions  (button clicks, /ask option selects)
        │
        └── POST → Router HTTP API → correct plugin instance via WS
```

---

## 4. The Router Process

### Responsibilities

The router is a standalone Node.js process — not an MCP server, not a Cloudflare Worker. It is a long-running daemon.

**Discord-facing side:**
- Holds the single `Discord.js` client with `client.login(DISCORD_BOT_TOKEN)`
- Receives all gateway events: `messageCreate`, `interactionCreate` (button clicks, select menus), `messageReactionAdd`
- Makes all outbound Discord REST API calls on behalf of plugin instances: `channel.send()`, `message.react()`, `message.edit()`

**Plugin-facing side:**
- Runs a WebSocket server that plugin instances connect to on startup
- Authenticates each incoming plugin connection using a shared `ROUTER_TOKEN`
- Receives channel registration from each plugin ("I handle channels X and Y")
- Routes inbound Discord events to the correct plugin via its WS connection
- Receives outbound action requests from plugins and executes them against the Discord API
- Tracks connection health via heartbeats; marks instances offline on disconnect

**Interaction-facing side (from Cloudflare Worker):**
- Exposes a small HTTP API (one endpoint: `POST /interaction`)
- The Cloudflare Worker, upon receiving a button click or select interaction for a channel, forwards it here
- The router looks up which plugin instance owns that channel and forwards the interaction event over its WebSocket

### Where the router runs

The router must be a **persistent process**, not serverless. Cloudflare Workers cannot hold a Discord.js gateway WebSocket. Options ranked by reliability:

| Location | Reliability | Accessibility | Recommendation |
|---|---|---|---|
| Oracle VM (Always Free) | High — persistent server | All instances reach it via public IP | Preferred for production |
| Local machine | Low — dies when laptop closes | Only local instances | Acceptable for development |
| Google Cloud Run | Medium — can scale to zero and lose WS | Needs min-instances=1 | Works with `min-instances=1`, costs money |
| Dedicated Docker container on any VPS | High | All instances | Fine alternative |

**For development:** router runs locally. Local plugin instances connect to `ws://localhost:PORT`.  
**For production:** router runs as a Docker container on the Oracle ARM VM. All instances (local and cloud) connect to `wss://oracle-vm-ip:PORT` (or a domain if DNS is set up).

### Router state (in memory, not persisted)

```
instanceRegistry:
  instance_id  →  {
    ws_connection,
    channels: string[],       // channel IDs this instance handles
    connected_at: timestamp,
    last_heartbeat: timestamp,
    status: 'active' | 'disconnected'
  }

channelIndex:
  channel_id  →  instance_id    // reverse lookup for routing
```

On restart the registry is empty. Plugin instances reconnect automatically (plugin handles reconnection) and re-register their channels, rebuilding the index.

---

## 5. The IPC Protocol

All messages between router and plugin instances travel as JSON frames over the WebSocket connection. Every frame has a `type` field.

### Plugin → Router frames

**Registration** (sent immediately after connect, re-sent after reconnect)
```
type: "register"
instance_id: string         // stable UUID for this instance; from env var or generated at first start
channels: string[]          // Discord channel IDs this instance handles
token: string               // ROUTER_TOKEN for auth
```

**Outbound action — send reply**
```
type: "reply"
channel_id: string
text: string
reply_to: string | null     // message_id to thread under, or null
files: string[] | null      // absolute paths to attach
```

**Outbound action — edit message**
```
type: "edit_message"
channel_id: string
message_id: string
text: string
```

**Outbound action — react**
```
type: "react"
channel_id: string
message_id: string
emoji: string
```

**Outbound action — fetch messages**
```
type: "fetch_messages"
channel_id: string
limit: number
request_id: string          // correlates async response
```

**Outbound action — send ask embed**
```
type: "ask"
channel_id: string
question: string
options: string[]
ask_id: string              // correlates which ask this response belongs to
```

**Heartbeat**
```
type: "ping"
```

### Router → Plugin frames

**Inbound Discord message**
```
type: "discord_message"
channel_id: string
message_id: string
user: string                // username
user_id: string
content: string
attachments: { name, type, size, url }[]
ts: string                  // ISO timestamp
```

**Interaction result** (button click / option select from ask)
```
type: "interaction_result"
ask_id: string              // matches the ask_id from the ask frame
channel_id: string
selected: string            // option text the user chose
user_id: string
```

**fetch_messages response**
```
type: "fetch_messages_result"
request_id: string
messages: { id, author, content, ts }[]
```

**Registration acknowledgement**
```
type: "registered"
instance_id: string
channels: string[]
conflict: string[] | null   // any channels that were already claimed by another instance
```

**Heartbeat response**
```
type: "pong"
```

**Error**
```
type: "error"
code: string
message: string
```

---

## 6. Modified Plugin (server.ts)

This is the most significant code change. The plugin file is restructured around these principles:

- **Remove Discord.js entirely.** No `import { Client } from 'discord.js'`. No `client.login()`. No gateway connection.
- **Add a WebSocket client** that connects to the router's `DISCORD_ROUTER_URL`.
- **Keep all MCP tool definitions unchanged** — `reply`, `ask`, `react`, `edit_message`, `fetch_messages`, `download_attachment` keep their exact signatures. Claude Code does not need to change how it calls tools.
- **Keep the XML message format unchanged** — inbound messages still arrive as `<channel source="discord" chat_id="..." ...>` tags. The plugin converts router frames to this format exactly as before.
- **Remove `access.json` management from the plugin.** Access control (channel allowlists, DM policy, pairing codes) moves to the router. The plugin only handles what Claude Code needs.

### What the plugin no longer does

- Reads `DISCORD_BOT_TOKEN`
- Manages `~/.claude/channels/discord/access.json`
- Handles the `pairing` flow (DM a code to users for approval)
- Runs the Discord gateway heartbeat loop
- Makes Discord REST API calls directly
- Listens for `interactionCreate` from Discord.js

### What the plugin now does

- Reads `DISCORD_ROUTER_URL` and `ROUTER_TOKEN` from env
- Reads `DISCORD_CHANNELS` to know which channels to register for
- Reads `DISCORD_INSTANCE_ID` (stable ID; generated once, stored alongside state)
- Connects to the router WebSocket on startup
- Sends a `register` frame with its channels
- Listens for `discord_message` frames and converts them to `<channel ...>` XML fed to Claude
- When Claude calls `reply(chat_id, text)`, sends a `reply` frame to the router
- When Claude calls `ask(chat_id, question, options)`, sends an `ask` frame; blocks on `interaction_result`
- Reconnects with exponential backoff if router connection drops

### Access control migration

The `access.json` system (pairing codes, DM policy, guild channel allowlists) currently lives entirely in the plugin. In the router architecture, this state moves to the router because the router is the process that sees inbound messages and must decide whether to forward them. The plugin only receives pre-filtered messages the router has decided to deliver.

The router takes over:
- Reading/writing `access.json` (or an equivalent store)
- The pairing code flow (DM-based approval)
- The `requireMention` check
- The `allowFrom` user ID filter

This is a meaningful responsibility shift — the router becomes the access control gatekeeper, not just a relay.

---

## 7. The Interaction Problem (Non-Trivial)

This is the most architecturally complex part of the design.

### Why it's complex

The `ask` tool posts an embed with Discord button components. When a user clicks a button, Discord delivers this as an **HTTP POST to the interactions endpoint** (the Cloudflare Worker at `/discord/ops/interactions` or `/discord/interactions`) — not as a gateway event that the Discord.js client sees via WebSocket.

So the current flow for button clicks is:
```
User clicks button → Discord API → HTTP POST → Cloudflare Worker → ?
```

In the current single-instance plugin, the plugin both holds the gateway (via Discord.js, which also receives `interactionCreate` events from the gateway for components) AND is the only consumer. With the router, there is no direct path from the Cloudflare Worker to the plugin instance.

### The gateway vs webhook duality

Discord sends `interactionCreate` events over **both**:
1. The gateway WebSocket (Discord.js `client.on('interactionCreate')` catches these)
2. The configured Interactions Endpoint URL (HTTP POST to the Worker)

These are the same event delivered via two channels. Currently the plugin uses the gateway path (1). The Worker handles the HTTP path (2) separately for slash commands.

### Solution: keep gateway path for component interactions

Since the router holds the Discord.js client and therefore the gateway connection, `client.on('interactionCreate')` in the **router** will fire for all button clicks and select menu interactions. The router receives the interaction event and routes it to the correct plugin via its WebSocket as an `interaction_result` frame.

This means:
- The router handles button interaction routing — no change to the Cloudflare Worker needed
- The Worker's interactions endpoint remains only for slash commands (ops bot and main bot)
- The plugin's `ask` tool sends an `ask` frame to the router, which posts the embed, waits for the button click via `client.on('interactionCreate')`, then sends `interaction_result` back to the plugin

The router must call `interaction.deferUpdate()` or `interaction.reply()` within 3 seconds of receiving the interaction (Discord's ACK timeout). The router does this immediately upon receiving the `interactionCreate` event, before forwarding to the plugin.

### Implication for `ask` flow

```
Claude calls ask(chat_id, question, options)
  ↓
Plugin sends ask frame to router (with ask_id)
  ↓
Router posts embed with buttons to Discord channel
  ↓
User clicks a button
  ↓
Discord fires interactionCreate on router's Discord.js client
  ↓
Router calls interaction.deferUpdate() immediately (within 3s)
  ↓
Router maps the interaction's custom_id → ask_id → channel_id → instance_id
  ↓
Router sends interaction_result frame to plugin
  ↓
Plugin unblocks the ask tool call and returns the selection to Claude
```

The `custom_id` on each button must encode enough information for the router to route it. Suggested format: `ask:<instance_id>:<ask_id>:<option_index>`. This avoids any shared database lookup.

---

## 8. Channel Registration and Conflict Resolution

### Dynamic registration (recommended)

Each plugin instance announces its channels when it connects. The router accepts these registrations and updates its `channelIndex`. If a channel is already claimed by another live instance, the router sends back a `registered` frame with `conflict: ["channel_id"]` listing the contested channels.

**Conflict policy options (choose one):**

| Policy | Behaviour | Best for |
|---|---|---|
| Last-writer-wins | New registration evicts old | Development (running /local twice replaces old session) |
| First-wins | New registration rejected for contested channels | Production (prevents accidental duplicates) |
| Operator-choice | Router sends conflict warning; ops bot shows a "Take over?" button | Full control |

Recommended default: last-writer-wins for simplicity, with a warning message sent to the contested channel ("A new session has taken over this channel").

### Static registration (alternative)

A config file on the router maps channel IDs to expected instance identifiers. The router rejects registrations for channels not in the static map. More rigid but prevents any accidental takeovers. Better suited for production deployments with fixed channel assignments.

---

## 9. Failure Modes and Recovery

### Router goes down

All plugin instances lose their WebSocket connection to the router. Each plugin's reconnection loop engages (exponential backoff, same as the daemon's current reconnection logic). When the router restarts, plugins reconnect and re-register within seconds. During downtime, Claude Code continues running but cannot send or receive Discord messages — the plugin's tool calls block until reconnection or timeout.

**Messages sent to Discord while router is down** are missed by Claude unless the plugin fetches message history on reconnect (it can call `fetch_messages` on startup to catch up).

### Plugin instance goes down

The router detects the WebSocket close. It marks the instance offline in the registry. Messages arriving for that channel accumulate on Discord but are not forwarded (no queue). When the plugin reconnects, it can call `fetch_messages` to retrieve recent messages.

If the router should notify Discord that a session is offline, it can send a message to the affected channel on instance disconnect.

### Discord gateway disconnect / INVALID_SESSION

Discord.js handles reconnection internally. It reconnects and resumes the session within a few seconds for network blips. For true session invalidation, Discord.js starts fresh but messages sent during the gap are not replayed. This is unchanged from the current behaviour.

### Oracle VM plugin connecting to local router

If the router runs locally and the laptop closes, Oracle VM instances lose connectivity. **This is why the router should run on a persistent host for production.** The plugin's reconnection loop handles the outage transparently once the router is back.

---

## 10. Access Control Migration

The `access.json` system currently in the plugin manages:
- DM policy (pairing / allowlist / disabled)
- User allowlists per channel (`allowFrom`)
- Pending pairing entries (users waiting for approval)
- `requireMention` flag per guild channel
- `mentionPatterns` for trigger matching
- UX config (chunk size, reaction emoji, reply threading mode)

In the router architecture, **this state lives in the router**, because the router must decide whether to forward a message to a plugin instance. The plugin should never receive messages from disallowed users.

The pairing flow (where a user DMs the bot a code) stays in the router. The router generates the code, delivers the DM, and updates its access state. The plugin is unaffected.

Persistence: the router can write a single `router-access.json` per channel, stored on the router host's filesystem. Alternatively, it can use a lightweight SQLite database for all channel state. This is cleaner than the current per-machine `access.json` approach because the state is centralised on the router host rather than split across every machine that has ever run a plugin instance.

---

## 11. Migration Path

A clean migration in three phases, with no breaking changes to existing functionality at each phase boundary.

### Phase 1 — Extract router, keep compatibility mode

Create the router process and modify the plugin to support both modes:
- `DISCORD_ROUTER_URL` set → connect to router (new mode)
- `DISCORD_ROUTER_URL` not set → use Discord.js directly (current mode, unchanged)

During Phase 1, existing single-instance setups work exactly as before. The router is opt-in.

Test with one instance connected to the router. Verify all MCP tools function (reply, ask, fetch_messages, react, edit_message).

### Phase 2 — Multi-instance validation

Launch two plugin instances for two different channels, both connected to the same router. Verify:
- No INVALID_SESSION conflicts
- Messages from channel A reach only plugin A
- Messages from channel B reach only plugin B
- Button clicks from `ask` embeds route correctly
- Plugin restart reconnects and re-registers cleanly

### Phase 3 — Cross-machine deployment

Move the router to the Oracle VM. Configure router address as a domain or stable IP. Launch plugin instances from both local machine and Oracle VM, both connecting to the Oracle-hosted router. Validate the full flow.

At Phase 3 completion, remove the compatibility mode (Discord.js fallback) from the plugin. The plugin no longer depends on `discord.js` as a package dependency.

---

## 12. New Files and Changes Summary

### New files

| Path | Purpose |
|---|---|
| `discord-router/router.ts` | Main router process entry point |
| `discord-router/instance-registry.ts` | Channel → instance mapping and WS management |
| `discord-router/access-control.ts` | Ported and refactored access.json logic |
| `discord-router/interaction-router.ts` | Handles Discord button/select events, routes to instances |
| `discord-router/Dockerfile` | Container image for running the router on Oracle VM |
| `discord-router/router.config.example.json` | Example static channel assignment config |
| `scripts/start-router.sh` | Convenience wrapper to start the router locally |

### Modified files

| Path | Change |
|---|---|
| `docker/discord-plugin/server.ts` | Remove Discord.js, add WebSocket client, keep MCP tool interface |
| `claude-proxy.sh` | Add `--router-url` and `--instance-id` flags |
| `scripts/sync-discord-plugin.sh` | Unchanged — still syncs to Claude cache |
| `discord_session_launcher.py` | Pass `DISCORD_ROUTER_URL` to launched Claude processes |
| `docker/Dockerfile.claude-discord` | Remove discord.js from image, add router client deps |
| `.dev.vars` (template) | Add `DISCORD_ROUTER_URL`, `ROUTER_TOKEN`, `DISCORD_INSTANCE_ID` |

### Unchanged

| Component | Why unchanged |
|---|---|
| `LauncherDO.ts` | Still relays launch commands; unrelated to Discord gateway |
| `opsInteractions.ts` | Ops bot slash commands unchanged |
| `src/index.ts` routes | Worker routing unchanged |
| `GoalAgent.ts` | Unrelated |
| Oracle VM provisioning scripts | Infrastructure unchanged |
| GCP scripts | Infrastructure unchanged |

---

## 13. New Environment Variables

| Variable | Who reads it | Purpose |
|---|---|---|
| `DISCORD_ROUTER_URL` | Plugin | WebSocket URL of the router (`ws://...` or `wss://...`) |
| `ROUTER_TOKEN` | Plugin + Router | Shared secret; plugin sends in `register` frame for auth |
| `DISCORD_INSTANCE_ID` | Plugin | Stable identifier for this Claude instance (UUID); used in button `custom_id` encoding and conflict detection |
| `ROUTER_HTTP_PORT` | Router | Port for the HTTP API (Cloudflare Worker → router interaction forwarding, if needed) |
| `ROUTER_WS_PORT` | Router | Port for plugin WebSocket connections |
| `ROUTER_ACCESS_STATE_DIR` | Router | Directory for per-channel access state files |
| `ROUTER_CONFLICT_POLICY` | Router | `last-wins` \| `first-wins` |

The router continues to read `DISCORD_BOT_TOKEN` (the only process that needs it).

---

## 14. Open Decisions

These design questions should be settled before implementation begins.

**A. Router location for first implementation**  
Local only (simpler to iterate) or Oracle VM from the start (production-realistic)? Recommendation: local first, Oracle VM in Phase 3.

**B. Access control state storage**  
Single `router-access.json` per channel, or a SQLite database for all channels? SQLite is safer for concurrent writes if future router design adds multiple router instances, but is overengineered for a single-router setup.

**C. Message queuing during instance downtime**  
When a plugin instance disconnects, should the router queue messages for that channel (and deliver on reconnect), or drop them? Queuing requires a bounded buffer and TTL policy. Dropping is simpler but means missed messages during restarts. Recommendation: drop for now, rely on plugin's `fetch_messages` on reconnect for catch-up.

**D. Conflict policy default**  
Last-writer-wins (simpler, natural for `/local` replace) or first-wins (safer for production)? Recommendation: last-wins with a Discord notification to the channel.

**E. Router language**  
Node.js (same as plugin, shares Discord.js expertise) or Python (same as daemon)? Since the router replaces Discord.js functionality and the plugin is already TypeScript/Bun, Node.js/TypeScript is the natural choice. Avoids a second runtime on the Oracle VM.

**F. Plugin backward compatibility mode**  
How long to maintain the fallback Discord.js path in the plugin? During active development this is useful. Long-term it is dead weight. Recommendation: remove after Phase 2 validation passes.
