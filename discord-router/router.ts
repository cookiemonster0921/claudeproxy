#!/usr/bin/env node
/**
 * discord-router/router.ts
 *
 * The Discord gateway singleton. Holds ONE Discord.js client (one bot token =
 * one gateway connection). Plugin instances running on any machine connect here
 * via WebSocket, register their channel IDs, and the router:
 *   • forwards inbound Discord messages to the correct plugin instance
 *   • executes outbound Discord API calls (reply, react, edit, fetch, embeds)
 *     on behalf of the plugin and returns results
 *   • routes button-click interactions (ask, permission) back to the plugin
 *
 * Run:
 *   DISCORD_BOT_TOKEN=... ROUTER_TOKEN=... npx tsx discord-router/router.ts
 *
 * Environment variables:
 *   DISCORD_BOT_TOKEN   Required — the single bot token
 *   ROUTER_TOKEN        Required — shared secret; plugin instances must send this in their register frame
 *   ROUTER_WS_PORT      WebSocket server port (default: 7777)
 *   ROUTER_HTTP_PORT    Health/status HTTP port (default: 7778)
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type TextBasedChannel,
} from 'discord.js'
import { WebSocketServer, WebSocket } from 'ws'
import { randomBytes } from 'crypto'
import * as http from 'http'

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const ROUTER_TOKEN      = process.env.ROUTER_TOKEN
const WS_PORT           = parseInt(process.env.ROUTER_WS_PORT  ?? '7777')
const HTTP_PORT         = parseInt(process.env.ROUTER_HTTP_PORT ?? '7778')

if (!DISCORD_BOT_TOKEN) { console.error('[router] DISCORD_BOT_TOKEN required'); process.exit(1) }
if (!ROUTER_TOKEN)       { console.error('[router] ROUTER_TOKEN required');       process.exit(1) }

// ── Registry ──────────────────────────────────────────────────────────────────
interface InstanceEntry {
  ws: WebSocket
  instanceId: string
  channels: string[]        // Discord channel IDs this instance handles
  connectedAt: number
}

/** instance_id → entry */
const instances = new Map<string, InstanceEntry>()
/** channel_id → instance_id */
const channelIndex = new Map<string, string>()
/** interactionId → ButtonInteraction (stored after deferUpdate so we can editReply later) */
const pendingInteractions = new Map<string, ButtonInteraction>()

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendTo(ws: WebSocket, frame: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function routeToChannel(channelId: string, frame: object): boolean {
  const instanceId = channelIndex.get(channelId)
  if (!instanceId) return false
  const entry = instances.get(instanceId)
  if (!entry) return false
  sendTo(entry.ws, frame)
  return true
}

async function getTextChannel(channelId: string): Promise<TextBasedChannel> {
  const ch = await client.channels.fetch(channelId)
  if (!ch || !ch.isTextBased()) throw new Error(`channel ${channelId} not found or not text-based`)
  return ch
}

// ── WebSocket server (plugin instances connect here) ─────────────────────────
const wss = new WebSocketServer({ port: WS_PORT })

wss.on('connection', (ws: WebSocket) => {
  let instanceId: string | null = null
  let registered = false

  ws.on('message', async (raw: Buffer) => {
    let frame: Record<string, unknown>
    try { frame = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }

    // ── Registration ─────────────────────────────────────────────────────────
    if (frame['type'] === 'register') {
      if (frame['token'] !== ROUTER_TOKEN) {
        sendTo(ws, { type: 'error', code: 'auth', message: 'invalid token' })
        ws.close(1008, 'auth failed')
        return
      }

      instanceId = (frame['instance_id'] as string | undefined) ?? randomBytes(8).toString('hex')
      const channels: string[] = Array.isArray(frame['channels']) ? (frame['channels'] as string[]) : []

      // Clean up previous registration for this instance_id (reconnect)
      const prev = instances.get(instanceId)
      if (prev) {
        prev.channels.forEach(ch => { if (channelIndex.get(ch) === instanceId) channelIndex.delete(ch) })
      }

      // Detect conflicts — last-writer-wins (new registration evicts old)
      const conflicts: string[] = []
      for (const ch of channels) {
        const existingId = channelIndex.get(ch)
        if (existingId && existingId !== instanceId) {
          conflicts.push(ch)
          const oldEntry = instances.get(existingId)
          if (oldEntry) {
            sendTo(oldEntry.ws, { type: 'channel_evicted', channel_id: ch, by: instanceId })
            oldEntry.channels = oldEntry.channels.filter(c => c !== ch)
          }
        }
      }

      instances.set(instanceId, { ws, instanceId, channels: [...channels], connectedAt: Date.now() })
      channels.forEach(ch => channelIndex.set(ch, instanceId!))
      registered = true

      sendTo(ws, {
        type: 'registered',
        instance_id: instanceId,
        channels,
        conflict: conflicts.length > 0 ? conflicts : null,
      })
      console.log(`[router] instance ${instanceId} registered channels=[${channels.join(',')}]${conflicts.length ? ` conflicts=[${conflicts.join(',')}]` : ''}`)
      return
    }

    if (!registered || !instanceId) return

    if (frame['type'] === 'ping') {
      sendTo(ws, { type: 'pong' })
      return
    }

    // ── Action RPC (plugin → router → Discord → reply to plugin) ─────────────
    const req_id = frame['req_id'] as string | undefined
    const respond = (ok: boolean, result?: unknown, error?: string): void => {
      sendTo(ws, { type: 'action_result', req_id, ok, ...(ok ? { result } : { error }) })
    }

    try {
      switch (frame['type']) {

        case 'reply': {
          const ch = await getTextChannel(frame['channel_id'] as string)
          if (!('send' in ch)) throw new Error('channel not sendable')
          const payload: Record<string, unknown> = { content: frame['text'] as string }
          if (frame['reply_to']) payload['reply'] = { messageReference: frame['reply_to'], failIfNotExists: false }
          const sent = await (ch as TextBasedChannel & { send: Function }).send(payload)
          respond(true, { message_id: sent.id })
          break
        }

        case 'react': {
          const ch = await getTextChannel(frame['channel_id'] as string)
          const msg = await (ch as any).messages.fetch(frame['message_id'] as string)
          await msg.react(frame['emoji'] as string)
          respond(true, 'reacted')
          break
        }

        case 'edit_message': {
          const ch = await getTextChannel(frame['channel_id'] as string)
          const msg = await (ch as any).messages.fetch(frame['message_id'] as string)
          const edited = await msg.edit(frame['text'] as string)
          respond(true, { message_id: edited.id })
          break
        }

        case 'fetch_messages': {
          const ch = await getTextChannel(frame['channel_id'] as string)
          const limit = Math.min((frame['limit'] as number | undefined) ?? 20, 100)
          const msgs = await (ch as any).messages.fetch({ limit })
          const me = client.user?.id
          const arr = [...msgs.values()].reverse() as any[]
          const text = arr.length === 0
            ? '(no messages)'
            : arr.map((m: any) => {
                const who = m.author.id === me ? 'me' : m.author.username
                const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
                return `[${m.createdAt.toISOString()}] ${who}: ${m.content.replace(/[\r\n]+/g, ' ⏎ ')}  (id: ${m.id}${atts})`
              }).join('\n')
          respond(true, { text })
          break
        }

        case 'get_attachment_urls': {
          const ch = await getTextChannel(frame['channel_id'] as string)
          const msg = await (ch as any).messages.fetch(frame['message_id'] as string)
          const atts = [...msg.attachments.values()].map((a: any) => ({
            id: a.id, url: a.url, name: a.name ?? a.id, size: a.size, contentType: a.contentType,
          }))
          respond(true, { attachments: atts })
          break
        }

        case 'typing': {
          try {
            const ch = await getTextChannel(frame['channel_id'] as string)
            if ('sendTyping' in ch) await (ch as any).sendTyping()
          } catch { /* fire-and-forget */ }
          respond(true, null)
          break
        }

        case 'ack_reaction': {
          try {
            const ch = await getTextChannel(frame['channel_id'] as string)
            const msg = await (ch as any).messages.fetch(frame['message_id'] as string)
            await msg.react(frame['emoji'] as string)
          } catch { /* fire-and-forget */ }
          respond(true, null)
          break
        }

        case 'send_permission_embed': {
          const ch = await getTextChannel(frame['channel_id'] as string)
          if (!('send' in ch)) throw new Error('channel not sendable')

          let prettyInput: string
          try { prettyInput = JSON.stringify(JSON.parse(frame['input_preview'] as string), null, 2) }
          catch { prettyInput = frame['input_preview'] as string }
          const MAX_INPUT = 950
          const inputDisplay = prettyInput.length > MAX_INPUT ? prettyInput.slice(0, MAX_INPUT) + '\n… (truncated)' : prettyInput
          const desc = (frame['description'] as string) || ''
          const descTrunc = desc.length > 300 ? desc.slice(0, 297) + '…' : desc

          const embed = new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle('🔐 Permission Request')
            .addFields(
              { name: 'Tool', value: `\`${frame['tool_name']}\``, inline: true },
              { name: 'Description', value: descTrunc || '(none)' },
              { name: 'Input', value: `\`\`\`json\n${inputDisplay}\n\`\`\`` },
            )

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`perm:allow:${frame['request_id']}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`perm:deny:${frame['request_id']}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
          )

          const sent = await (ch as any).send({ embeds: [embed], components: [row] })
          respond(true, { message_id: sent.id })
          break
        }

        case 'send_ask_embed': {
          const ch = await getTextChannel(frame['channel_id'] as string)
          if (!('send' in ch)) throw new Error('channel not sendable')

          const options = frame['options'] as string[]
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            options.map((label: string, idx: number) =>
              new ButtonBuilder()
                .setCustomId(`ask:${frame['question_id']}:${idx}`)
                .setLabel(label.slice(0, 25))
                .setStyle(ButtonStyle.Primary),
            ),
          )

          const sent = await (ch as any).send({ content: frame['question'] as string, components: [row] })
          respond(true, { message_id: sent.id })
          break
        }

        case 'update_interaction': {
          const interaction = pendingInteractions.get(frame['interaction_id'] as string)
          if (!interaction) {
            respond(false, undefined, 'interaction not found or expired')
            break
          }
          const payload = frame['update_payload'] as Record<string, unknown>
          await interaction.editReply(payload as any)
          pendingInteractions.delete(frame['interaction_id'] as string)
          respond(true, null)
          break
        }

        default:
          respond(false, undefined, `unknown action type: ${frame['type']}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[router] action error (${frame['type']}):`, msg)
      respond(false, undefined, msg)
    }
  })

  ws.on('close', () => {
    if (instanceId && registered) {
      const entry = instances.get(instanceId)
      if (entry) {
        entry.channels.forEach(ch => { if (channelIndex.get(ch) === instanceId) channelIndex.delete(ch) })
        instances.delete(instanceId)
      }
      console.log(`[router] instance ${instanceId} disconnected`)
    }
  })

  ws.on('error', (err) => {
    console.error(`[router] ws error (instance=${instanceId ?? 'unregistered'}):`, err.message)
  })
})

// ── Discord gateway ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

client.on('messageCreate', (msg) => {
  if (msg.author.bot) return

  // Thread → parent for routing (mirrors the access gate in the plugin)
  const routingChannelId = msg.channel.isThread?.() ? (msg.channel.parentId ?? msg.channelId) : msg.channelId

  const routed = routeToChannel(routingChannelId, {
    type: 'discord_message',
    channel_id: msg.channelId,         // actual channel for reply routing
    routing_channel_id: routingChannelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    content: msg.content,
    ts: msg.createdAt.toISOString(),
    is_dm: msg.channel.type === ChannelType.DM,
    attachments: [...msg.attachments.values()].map(a => ({
      id: a.id,
      name: a.name ?? a.id,
      contentType: a.contentType,
      size: a.size,
      url: a.url,
    })),
  })

  if (!routed) {
    // No instance registered for this channel — silently drop
  }
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return

  const channelId = interaction.channelId
  if (!channelId) return

  // Must acknowledge within 3 seconds — do it immediately before any async work
  try {
    await interaction.deferUpdate()
  } catch {
    return  // Interaction already expired
  }

  const instanceId = channelIndex.get(channelId)
  if (!instanceId) return  // No plugin registered for this channel

  const entry = instances.get(instanceId)
  if (!entry) return

  // Store interaction object so plugin can call update_interaction later
  const interactionKey = `${interaction.id}`
  pendingInteractions.set(interactionKey, interaction)
  // Auto-expire after 14 minutes (Discord's followUp/editReply window is 15 min)
  setTimeout(() => pendingInteractions.delete(interactionKey), 14 * 60 * 1000)

  sendTo(entry.ws, {
    type: 'interaction',
    interaction_id: interactionKey,
    custom_id: interaction.customId,
    channel_id: channelId,
    message_id: interaction.message.id,
    user: interaction.user.username,
    user_id: interaction.user.id,
  })
})

client.on('error', err => console.error('[router] Discord client error:', err))

client.once('ready', c => {
  console.log(`[router] Gateway connected as ${c.user.tag}`)
  console.log(`[router] WebSocket server on port ${WS_PORT}`)
  console.log(`[router] Status HTTP on port ${HTTP_PORT}`)
})

client.login(DISCORD_BOT_TOKEN!).catch(err => {
  console.error('[router] login failed:', err)
  process.exit(1)
})

// ── Health / status HTTP server ───────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/status') {
    const body = JSON.stringify({
      ok: client.isReady(),
      discord_tag: client.user?.tag ?? null,
      instances: instances.size,
      channels_indexed: channelIndex.size,
      instance_list: [...instances.values()].map(e => ({
        instance_id: e.instanceId,
        channels: e.channels,
        connected_for_ms: Date.now() - e.connectedAt,
      })),
    }, null, 2)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end('not found')
})
httpServer.listen(HTTP_PORT)
