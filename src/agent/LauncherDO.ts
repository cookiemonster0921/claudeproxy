/**
 * LauncherDO — Durable Object that relays launch commands from the Discord ops
 * bot to local `discord_session_launcher.py` daemons via WebSocket.
 *
 * ── Why Hibernatable WebSocket API ───────────────────────────────────────────
 *
 * The original implementation used the standard WebSocket API (ws.accept() +
 * an in-memory Set). This caused a subtle but fatal bug:
 *
 *   1. Daemon connects → DO's in-memory daemonSockets Set = { ws1 }
 *   2. Cloudflare hibernates the DO between requests (normal behaviour)
 *   3. In-memory state is wiped → daemonSockets = {}
 *   4. Discord /local confirm arrives → dispatch finds 0 sockets → "No daemons"
 *
 * The Hibernatable WebSocket API fixes this:
 *   • ctx.acceptWebSocket(ws)  — runtime owns the WebSocket, survives hibernation
 *   • ctx.getWebSockets()      — always returns the live list, even after sleep
 *   • webSocketMessage/Close/Error methods — called by the runtime when events fire
 *   • ctx.storage for pendingConfigs — SQLite-backed, survives hibernation
 *
 * ── Data flow ─────────────────────────────────────────────────────────────────
 *
 *  Discord /local command (opsInteractions.ts)
 *        │  POST /store   → stores command, returns token
 *        │  shows Confirm button
 *        │  POST /dispatch { token } → broadcasts to daemon sockets
 *        ▼
 *  LauncherDO  ◄──── persistent WebSocket ────  discord_session_launcher.py
 *        │                                                │
 *        └─── JSON frame { command, session_id } ───────►│
 *                                                         │  osascript / gnome-terminal
 *                                                         ▼  new Terminal tab → claude-proxy.sh
 *
 * ── Endpoints ─────────────────────────────────────────────────────────────────
 *
 *  WS  /ws          Daemon WebSocket upgrade (auth handled in the Worker).
 *  POST /store      { ...config }  →  { token: string }  (expires 10 min, SQLite-backed)
 *  POST /dispatch   { token } or { command, session_id? }  →  { ok, sent, connected }
 *  GET  /status     →  { connected_daemons, pending_configs }
 */

export class LauncherDO {
	private readonly ctx: DurableObjectState;

	constructor(state: DurableObjectState, _env: unknown) {
		this.ctx = state;
	}

	// ── HTTP / WebSocket request handler ──────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/^.*\//, ''); // last segment after final /

		// ── WebSocket upgrade: daemon connects here ────────────────────────────
		if (path === 'ws') {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected WebSocket upgrade', { status: 426 });
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

			// Hibernatable API: the runtime takes ownership of the server socket.
			// It will call webSocketMessage / webSocketClose / webSocketError when events fire.
			// The socket survives DO hibernation — ctx.getWebSockets() always returns it.
			this.ctx.acceptWebSocket(server);

			const count = this.ctx.getWebSockets().length;
			console.log(`[LauncherDO] daemon connected (${count} total)`);

			return new Response(null, {
				status: 101,
				webSocket: client,
			} as ResponseInit & { webSocket: WebSocket });
		}

		// ── Store a pending launch config (SQLite-backed) ─────────────────────
		if (path === 'store' && request.method === 'POST') {
			const config = await request.json();

			// 8-char hex token fits comfortably inside Discord's 100-char custom_id limit
			const token = Array.from(crypto.getRandomValues(new Uint8Array(4)))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');

			const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
			await this.ctx.storage.put(`pending:${token}`, { config, expiresAt });

			return Response.json({ token });
		}

		// ── Dispatch: look up stored config (or accept direct payload) ─────────
		if (path === 'dispatch' && request.method === 'POST') {
			const body = (await request.json()) as { token?: string; [k: string]: unknown };
			let payload: unknown;

			if (body.token) {
				const record = await this.ctx.storage.get<{ config: unknown; expiresAt: number }>(
					`pending:${body.token}`,
				);
				if (!record || Date.now() > record.expiresAt) {
					await this.ctx.storage.delete(`pending:${body.token}`);
					return Response.json(
						{ ok: false, error: 'Token not found or expired. Re-run /local to start over.' },
						{ status: 404 },
					);
				}
				await this.ctx.storage.delete(`pending:${body.token}`);
				payload = record.config;
			} else {
				// Direct dispatch — used by the CLI trigger tool (no token)
				payload = body;
			}

			return this.broadcast(JSON.stringify(payload), payload as { target?: string; mode?: string });
		}

		// ── Status ─────────────────────────────────────────────────────────────
		if (path === 'status') {
			const sockets = this.ctx.getWebSockets();
			// Count non-expired pending configs (approximate; avoids a full scan)
			const allPending = await this.ctx.storage.list<{ expiresAt: number }>({ prefix: 'pending:' });
			const now = Date.now();
			let pendingCount = 0;
			for (const [, v] of allPending) {
				if (v.expiresAt > now) pendingCount++;
			}
			return Response.json({
				connected_daemons: sockets.length,
				pending_configs: pendingCount,
			});
		}

		return new Response('Not found', { status: 404 });
	}

	// ── Hibernatable WebSocket event handlers ─────────────────────────────────
	// The Cloudflare runtime calls these when a message/close/error fires,
	// even if the DO was hibernating between events.

	webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
		// Daemons send ACK / NACK JSON frames after attempting to launch
		const text = typeof message === 'string' ? message : '(binary)';
		console.log('[LauncherDO] daemon ACK:', text);
	}

	webSocketClose(_ws: WebSocket, _code: number, _reason: string): void {
		const remaining = this.ctx.getWebSockets().length;
		console.log(`[LauncherDO] daemon disconnected (${remaining} remaining)`);
	}

	webSocketError(_ws: WebSocket, error: unknown): void {
		console.error('[LauncherDO] daemon socket error:', error);
	}

	// ── Private ───────────────────────────────────────────────────────────────

	private broadcast(frame: string, meta?: { target?: string; mode?: string }): Response {
		const sockets = this.ctx.getWebSockets();
		let sent = 0;
		for (const ws of sockets) {
			try {
				ws.send(frame);
				sent++;
			} catch (err) {
				// Stale socket — close gracefully so the runtime cleans it up
				console.warn('[LauncherDO] send failed, closing stale socket:', err);
				try { ws.close(1011, 'send error'); } catch { /* already closed */ }
			}
		}
		console.log(`[LauncherDO] broadcast: sent=${sent}/${sockets.length}`);
		return Response.json({ ok: true, sent, connected: sockets.length, target: meta?.target, mode: meta?.mode });
	}
}
