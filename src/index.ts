// Anthropic-compatible Claude Code proxy — routes to multiple LLM providers

import type { Env, MessagesRequest } from './types';
import { CORS_HEADERS, jsonResponse, jsonError, stringifySystem } from './types';
import { loadSettings } from './config';
import { ProxyError } from './error';
import { PROVIDER_CATALOG } from './model-router';
import { ProxyService } from './proxy-service';
import type { AnalyticsContext } from './analytics';
import { logAnalytics, hashClientIp, estimateCostUsd, querySummary } from './analytics';
import { getDashboardHtml } from './dashboard';
import { getSessionsHtml } from './sessions-ui';
import { handleDiscordInteraction } from './discord/interactions';
import { handleOpsDiscordInteraction } from './discord/opsInteractions';
import { classifyRequest, hasRetryHeader } from './token-accounting';
import { routeAgentRequest } from 'agents';

// Re-export Durable Object and Workflow classes for Cloudflare registration
export { GoalAgent } from './agent/GoalAgent';
export { GoalWorkflow } from './agent/GoalWorkflow';
export { LauncherDO } from './agent/LauncherDO';

// ---------------------------------------------------------------------------
// Analytics helpers
// ---------------------------------------------------------------------------

// Assemble and persist an analytics event for a completed request.
// Always called via ctx.waitUntil() — never blocks the user response.
async function persistAnalytics(
	db: D1Database,
	request: Request,
	analyticsCtx: AnalyticsContext,
	meta: {
		id: string;
		timestamp: string;
		method: string;
		path: string;
		status: number;
		durationMs: number;
		ipHashSecret: string;
	},
): Promise<void> {
	await analyticsCtx.completion;

	const ip =
		request.headers.get('CF-Connecting-IP') ??
		request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ??
		'';
	const clientIpHash = await hashClientIp(ip, meta.ipHashSecret);

	const provider = analyticsCtx.provider;
	const requestKind = classifyRequest(analyticsCtx.promptSnapshot, meta.status, analyticsCtx.errorType);
	const finalRequestKind = analyticsCtx.requestKind ?? requestKind;
	const providerUsageFound = analyticsCtx.providerUsageFound === true;
	const estimatedContextTokens = analyticsCtx.estimatedContextTokens ?? 0;
	const estimatedPromptTokens = analyticsCtx.estimatedPromptTokens ?? 0;
	const estimatedToolResultTokens = analyticsCtx.estimatedToolResultTokens ?? 0;
	const billableInputTokens = analyticsCtx.billableInputTokens ?? 0;
	const billableOutputTokens = analyticsCtx.billableOutputTokens ?? 0;
	const estimatedOutputTokens = analyticsCtx.estimatedOutputTokens ?? billableOutputTokens;
	const cachedInputTokens = analyticsCtx.cachedInputTokens ?? 0;
	const failedRequestTokens =
		analyticsCtx.failedRequestTokens ?? (meta.status >= 400 && !providerUsageFound ? estimatedContextTokens : 0);
	const headerRetry = hasRetryHeader(request.headers);
	const retryMeta = await detectRetry(db, {
		model: analyticsCtx.model,
		provider,
		requestKind: finalRequestKind,
		estimatedContextTokens,
		promptSnapshot: analyticsCtx.promptSnapshot,
		status: meta.status,
		headerRetry,
	});
	const wasRetry = analyticsCtx.wasRetry ?? retryMeta.wasRetry;
	const retryCount = analyticsCtx.retryCount ?? retryMeta.retryCount;

	await logAnalytics(db, {
		id: meta.id,
		timestamp: meta.timestamp,
		method: meta.method,
		path: meta.path,
		model: analyticsCtx.model,
		provider,
		stream: analyticsCtx.stream ?? false,
		status_code: meta.status,
		success: meta.status < 400,
		duration_ms: meta.durationMs,
		approximate_input_tokens: estimatedContextTokens,
		approximate_output_tokens: estimatedOutputTokens,
		estimated_cost_usd: estimateCostUsd(provider, analyticsCtx.model, billableInputTokens, billableOutputTokens),
		estimated_context_tokens: estimatedContextTokens,
		estimated_prompt_tokens: estimatedPromptTokens,
		estimated_tool_result_tokens: estimatedToolResultTokens,
		billable_input_tokens: billableInputTokens,
		billable_output_tokens: billableOutputTokens,
		cached_input_tokens: cachedInputTokens,
		failed_request_tokens: failedRequestTokens,
		request_kind: finalRequestKind,
		was_retry: wasRetry,
		retry_count: retryCount,
		provider_usage_json: analyticsCtx.providerUsageJson,
		error_type: analyticsCtx.errorType,
		fallback_used: false,
		user_agent: request.headers.get('User-Agent') ?? undefined,
		client_ip_hash: clientIpHash,
		prompt_snapshot: analyticsCtx.promptSnapshot,
		response_snapshot: analyticsCtx.responseSnapshot,
		tool_snapshot: analyticsCtx.toolSnapshot,
		source: undefined,
		discord_guild_id: undefined,
		discord_channel_id: undefined,
		discord_command: undefined,
	});

	console.log(
		JSON.stringify({
			event: 'analytics_accounting',
			request_id: meta.id,
			status_code: meta.status,
			request_kind: finalRequestKind,
			estimated_context_tokens: estimatedContextTokens,
			billable_input_tokens: billableInputTokens,
			billable_output_tokens: billableOutputTokens,
			provider_usage_found: providerUsageFound,
		}),
	);
}

async function detectRetry(
	db: D1Database,
	event: {
		model: string | undefined;
		provider: string | undefined;
		requestKind: string | undefined;
		estimatedContextTokens: number;
		promptSnapshot: string | undefined;
		status: number;
		headerRetry: boolean;
	},
): Promise<{ wasRetry: boolean; retryCount: number }> {
	const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
       FROM request_logs
       WHERE timestamp >= ?
         AND COALESCE(model, '') = COALESCE(?, '')
         AND COALESCE(provider, '') = COALESCE(?, '')
         AND COALESCE(request_kind, '') = COALESCE(?, '')
         AND estimated_context_tokens = ?
         AND COALESCE(prompt_snapshot, '') = COALESCE(?, '')
         AND status_code = ?`,
		)
		.bind(
			since,
			event.model ?? null,
			event.provider ?? null,
			event.requestKind ?? null,
			event.estimatedContextTokens,
			event.promptSnapshot ?? null,
			event.status,
		)
		.first<{ count: number }>()
		.catch(() => ({ count: 0 }));
	const priorCount = Number(row?.count ?? 0);
	return { wasRetry: event.headerRetry || priorCount > 0, retryCount: event.headerRetry ? Math.max(1, priorCount + 1) : priorCount };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleHealth(requestId: string): Response {
	return jsonResponse({ ok: true, service: 'claude-code-cf-proxy' }, requestId);
}

// Friendly provider labels shown in the cproxy picker header.
const PROVIDER_LABELS: Record<string, string> = {
	workers_ai: 'Workers AI (CF binding — no key needed)',
	google_ai:  'Google AI Studio',
	openrouter: 'OpenRouter',
	nvidia_nim: 'NVIDIA NIM',
};

function handleModels(requestId: string, env: Env): Response {
	const created = Math.floor(Date.now() / 1000);

	// Build the model list from PROVIDER_CATALOG.
	// Each entry uses the real provider-qualified ID (e.g. "workers_ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast")
	// so cproxy can pass it verbatim as --model and the router handles it correctly.
	// Models whose required key is missing are excluded so the picker only shows
	// what will actually work (except Workers AI which never needs a key).
	const data = PROVIDER_CATALOG
		.filter(m => {
			if (!m.requires_key) return true; // always available (Workers AI binding)
			return !!(env as unknown as Record<string, string | undefined>)[m.requires_key];
		})
		.map(m => ({
			id:           m.id,
			object:       'model',
			created,
			owned_by:     m.owned_by,
			display_name: m.display_name,
			provider_label: PROVIDER_LABELS[m.owned_by] ?? m.owned_by,
		}));

	return jsonResponse({ object: 'list', data }, requestId);
}

async function handleCountTokens(request: Request, requestId: string): Promise<Response> {
	const body = (await request.json()) as MessagesRequest;
	let chars = stringifySystem(body.system)?.length ?? 0;
	for (const msg of body.messages) {
		if (typeof msg.content === 'string') {
			chars += msg.content.length;
		} else {
			for (const block of msg.content) {
				if (block.type === 'text') chars += block.text.length;
			}
		}
	}
	const inputTokens = Math.ceil(chars / 4);
	console.log(JSON.stringify({ event: 'count_tokens', requestId, inputTokens, ts: new Date().toISOString() }));
	return jsonResponse({ input_tokens: inputTokens }, requestId);
}

// ---------------------------------------------------------------------------
// Analytics API handlers
// ---------------------------------------------------------------------------

async function handleAnalyticsSummary(db: D1Database, requestId: string): Promise<Response> {
	try {
		const summary = await querySummary(db);
		return jsonResponse(summary, requestId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'D1 query failed';
		console.error(`[${requestId}] analytics summary error:`, msg);
		return jsonError(500, 'api_error', msg, requestId);
	}
}

async function handleAnalyticsRecent(db: D1Database, url: URL, requestId: string): Promise<Response> {
	const limitParam = parseInt(url.searchParams.get('limit') ?? '50', 10);
	const limit = Math.max(1, Math.min(limitParam, 200));
	try {
		const result = await db
			.prepare('SELECT * FROM request_logs ORDER BY timestamp DESC LIMIT ?')
			.bind(limit)
			.all();
		return jsonResponse({ results: result.results, limit }, requestId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'D1 query failed';
		console.error(`[${requestId}] analytics recent error:`, msg);
		return jsonError(500, 'api_error', msg, requestId);
	}
}

// ---------------------------------------------------------------------------
// Cloud session continuation API
// ---------------------------------------------------------------------------

interface CloudSession {
	cr_session_id?: string;
	cr_summary?: string;
	cr_updated_at?: string;
	wf_messages?: string;
	wf_updated_at?: string;
}

async function handleGetCloudSession(db: D1Database, channelId: string, requestId: string): Promise<Response> {
	try {
		const row = await db
			.prepare('SELECT * FROM cloud_sessions WHERE channel_id = ?')
			.bind(channelId)
			.first<CloudSession>();
		return jsonResponse(row ?? null, requestId);
	} catch (err) {
		return jsonError(500, 'api_error', err instanceof Error ? err.message : 'DB error', requestId);
	}
}

async function handleUpsertCloudSession(db: D1Database, request: Request, requestId: string): Promise<Response> {
	const body = (await request.json()) as Record<string, unknown>;
	const channelId = body.channel_id as string | undefined;
	if (!channelId) return jsonError(400, 'invalid_request_error', 'channel_id is required', requestId);

	const now = new Date().toISOString();
	try {
		await db
			.prepare(`
				INSERT INTO cloud_sessions (channel_id, cr_session_id, cr_summary, cr_updated_at, wf_messages, wf_updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(channel_id) DO UPDATE SET
					cr_session_id = COALESCE(excluded.cr_session_id, cr_session_id),
					cr_summary    = COALESCE(excluded.cr_summary, cr_summary),
					cr_updated_at = COALESCE(excluded.cr_updated_at, cr_updated_at),
					wf_messages   = COALESCE(excluded.wf_messages, wf_messages),
					wf_updated_at = COALESCE(excluded.wf_updated_at, wf_updated_at)
			`)
			.bind(
				channelId,
				(body.cr_session_id as string | undefined) ?? null,
				(body.cr_summary as string | undefined) ?? null,
				body.cr_session_id || body.cr_summary ? now : null,
				(body.wf_messages as string | undefined) ?? null,
				body.wf_messages ? now : null,
			)
			.run();
		return jsonResponse({ ok: true }, requestId);
	} catch (err) {
		return jsonError(500, 'api_error', err instanceof Error ? err.message : 'DB error', requestId);
	}
}

function handleDashboard(requestId: string): Response {
	return new Response(getDashboardHtml(), {
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'text/html; charset=utf-8',
			'x-request-id': requestId,
		},
	});
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function checkAuth(request: Request, env: Env): Response | null {
	if (!env.PROXY_TOKEN) return null;
	const authHeader = request.headers.get('Authorization');
	const proxyTokenHeader = request.headers.get('x-proxy-token');
	const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	const token = bearer ?? proxyTokenHeader;
	if (token !== env.PROXY_TOKEN) {
		return jsonError(401, 'authentication_error', 'Invalid or missing authentication token');
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const requestId = crypto.randomUUID();
		const startTime = Date.now();
		const url = new URL(request.url);
		const { method } = request;
		const { pathname } = url;
		const timestamp = new Date().toISOString();

		console.log(JSON.stringify({ event: 'request', requestId, method, path: pathname, ts: timestamp }));

		if (method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		// These paths are intentionally unauthenticated:
		//   /health              — plain reachability probe, no sensitive data
		//   /discord/*           — Discord authenticates via ed25519 signature, not PROXY_TOKEN
		//   GET /sessions        — serves static HTML only; all API calls under /sessions/* require auth
		const skipAuth =
			pathname === '/health' ||
			pathname === '/discord/interactions' ||
			pathname === '/discord/ops/interactions' ||
			(method === 'GET' && pathname === '/sessions');
		const authError = skipAuth ? null : checkAuth(request, env);
		if (authError) return authError;

		// Only log AI inference requests — skip health, models, dashboard, analytics, etc.
		const isAiRoute = method === 'POST' && pathname === '/v1/messages';
		const analyticsEnabled = env.ANALYTICS_ENABLED !== 'false' && env.DB !== undefined;
		// analyticsCtx is only created for AI routes; undefined for all other paths
		let analyticsCtx: AnalyticsContext | undefined;
		if (analyticsEnabled && isAiRoute) {
			analyticsCtx = {};
		}

		let response: Response;
		try {
			if (method === 'GET' && pathname === '/health') {
				response = handleHealth(requestId);
			} else if (method === 'GET' && pathname === '/v1/models') {
				response = handleModels(requestId, env);
			} else if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
				response = await handleCountTokens(request, requestId);
			} else if (method === 'POST' && pathname === '/v1/messages') {
				const body = (await request.json()) as MessagesRequest;
				const settings = loadSettings(env);
				const service = new ProxyService(settings, env);
				response = await service.handleMessages(body, requestId, analyticsCtx);
			} else if (method === 'GET' && pathname === '/analytics/summary') {
				if (!env.DB) return jsonError(503, 'api_error', 'D1 database not configured. Add the DB binding in wrangler.jsonc and run the migration.', requestId);
				response = await handleAnalyticsSummary(env.DB, requestId);
			} else if (method === 'GET' && pathname === '/analytics/recent') {
				if (!env.DB) return jsonError(503, 'api_error', 'D1 database not configured.', requestId);
				response = await handleAnalyticsRecent(env.DB, url, requestId);
			} else if (method === 'GET' && pathname === '/dashboard') {
				response = handleDashboard(requestId);
			} else if (method === 'GET' && pathname === '/cloud-sessions') {
				const channelId = url.searchParams.get('channel_id') ?? '';
				if (!channelId) response = jsonError(400, 'invalid_request_error', 'channel_id query param required', requestId);
				else if (!env.DB) response = jsonError(503, 'api_error', 'D1 not configured', requestId);
				else response = await handleGetCloudSession(env.DB, channelId, requestId);
			} else if (method === 'POST' && pathname === '/cloud-sessions') {
				if (!env.DB) response = jsonError(503, 'api_error', 'D1 not configured', requestId);
				else response = await handleUpsertCloudSession(env.DB, request, requestId);
				} else if (method === 'POST' && pathname === '/discord/ops/interactions') {
					response = await handleOpsDiscordInteraction(request, env);
				} else if (method === 'POST' && pathname === '/discord/interactions') {
				if (!env.DISCORD_PUBLIC_KEY) {
					response = jsonError(503, 'api_error', 'Discord not configured. Set DISCORD_PUBLIC_KEY in wrangler.jsonc vars or .dev.vars.', requestId);
				} else if (!env.DB) {
					response = jsonError(503, 'api_error', 'D1 database required for Discord integration.', requestId);
				} else {
					response = await handleDiscordInteraction(request, env, ctx);
				}
			} else if (method === 'GET' && pathname === '/discord/health') {
				response = jsonResponse({ ok: true, discord: !!env.DISCORD_PUBLIC_KEY }, requestId);

			// ── Local session launcher relay (LauncherDO) ─────────────────────
			// GET /launcher-ws  — WebSocket upgrade for discord_session_launcher.py daemons.
			//                    Daemons send Authorization: Bearer <PROXY_TOKEN>.
			// GET /launcher-status — How many daemons are connected (no auth required).
			} else if (pathname === '/launcher-ws') {
				if (!env.LAUNCHER_DO) {
					response = jsonError(503, 'api_error', 'LAUNCHER_DO not configured', requestId);
				} else if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
					response = jsonError(426, 'api_error', 'Expected WebSocket upgrade', requestId);
				} else {
					// Validate the daemon's bearer token before accepting the WebSocket
					const auth = request.headers.get('Authorization') ?? '';
					const expectedToken = env.PROXY_TOKEN ?? '';
					if (expectedToken && auth !== `Bearer ${expectedToken}`) {
						response = new Response('Unauthorized', { status: 401 });
					} else {
						const id = env.LAUNCHER_DO.idFromName('global');
						const stub = env.LAUNCHER_DO.get(id);
						response = await stub.fetch(new Request(new URL('/ws', request.url), request));
					}
				}
			} else if (method === 'GET' && pathname === '/launcher-status') {
				if (!env.LAUNCHER_DO) {
					response = jsonResponse({ connected_daemons: 0, configured: false }, requestId);
				} else {
					const id = env.LAUNCHER_DO.idFromName('global');
					const stub = env.LAUNCHER_DO.get(id);
					const r = await stub.fetch(new Request(new URL('/status', request.url)));
					response = r;
				}
			// POST /launcher-dispatch — external dispatch for CLI tools.
			// Requires Authorization: Bearer <PROXY_TOKEN>.
			// Body: { command: string, session_id?: string }
			} else if (method === 'POST' && pathname === '/launcher-dispatch') {
				const auth = request.headers.get('Authorization') ?? '';
				const expectedToken = env.PROXY_TOKEN ?? '';
				if (expectedToken && auth !== `Bearer ${expectedToken}`) {
					response = new Response('Unauthorized', { status: 401 });
				} else if (!env.LAUNCHER_DO) {
					response = jsonError(503, 'api_error', 'LAUNCHER_DO not configured', requestId);
				} else {
					const id = env.LAUNCHER_DO.idFromName('global');
					const stub = env.LAUNCHER_DO.get(id);
					const r = await stub.fetch(new Request(new URL('/dispatch', request.url), {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: request.body,
					}));
					response = r;
				}

			// ── Sessions web UI ───────────────────────────────────────────────
			// GET /sessions        — dashboard HTML (unauthenticated; API calls below require token)
			// POST /sessions/list  — list active cproxy_* tmux sessions on the computeengine daemon
			// POST /sessions/capture — capture terminal output from a session
			// POST /sessions/send    — send keystrokes to a session
			// POST /sessions/kill    — kill a session
			} else if (method === 'GET' && pathname === '/sessions') {
				response = new Response(getSessionsHtml(), {
					headers: { 'Content-Type': 'text/html; charset=utf-8', 'x-request-id': requestId },
				});
			} else if (method === 'POST' && pathname.startsWith('/sessions/')) {
				const action = pathname.slice('/sessions/'.length);
				const frameTypeMap: Record<string, string> = {
					list:    'compute_list_sessions',
					capture: 'compute_capture_session',
					send:    'compute_send_text',
					kill:    'compute_kill_session',
				};
				const frameType = frameTypeMap[action];
				if (!frameType) {
					response = jsonError(404, 'not_found', `Unknown sessions action: ${action}`, requestId);
				} else if (!env.LAUNCHER_DO) {
					response = jsonError(503, 'api_error', 'LAUNCHER_DO not configured', requestId);
				} else {
					const body = (await request.json()) as Record<string, unknown>;
					console.log(JSON.stringify({
						event: 'sessions_action', requestId, action,
						session: body.session ?? null, ts: timestamp,
					}));
					const id = env.LAUNCHER_DO.idFromName('global');
					const stub = env.LAUNCHER_DO.get(id);
					response = await stub.fetch(new Request(new URL('/compute-request', request.url), {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ frame_type: frameType, ...body }),
					}));
				}

			} else {
				// Try Cloudflare Agents SDK routing (/agents/* paths for Durable Object agents)
				const agentResponse = env.GOAL_AGENT ? await routeAgentRequest(request, env) : null;
				if (agentResponse) {
					response = agentResponse;
				} else {
					response = jsonError(404, 'not_found', `Unknown endpoint: ${method} ${pathname}`, requestId);
				}
			}
		} catch (err) {
			if (err instanceof ProxyError) {
				if (analyticsCtx) analyticsCtx.errorType = err.errorType;
				response = jsonError(err.status, err.errorType, err.message, requestId);
			} else {
				const message = err instanceof Error ? err.message : 'Internal server error';
				if (analyticsCtx) analyticsCtx.errorType = 'internal_error';
				console.error(`[${requestId}] Unhandled error:`, message);
				response = jsonError(500, 'api_error', message, requestId);
			}
		}

		const durationMs = Date.now() - startTime;
		console.log(JSON.stringify({ event: 'response', requestId, status: response.status, duration: durationMs }));

		// Fire-and-forget analytics insert — only for AI routes, never blocks the response
		if (analyticsEnabled && isAiRoute && analyticsCtx) {
			const ipHashSecret = env.IP_HASH_SECRET ?? 'dev-local-salt';
			if (!env.IP_HASH_SECRET) {
				console.warn('[analytics] IP_HASH_SECRET not set — using dev fallback. Set it as a secret for production.');
			}
			ctx.waitUntil(
				persistAnalytics(env.DB!, request, analyticsCtx, {
					id: requestId,
					timestamp,
					method,
					path: pathname,
					status: response.status,
					durationMs,
					ipHashSecret,
				}),
			);
		}

		return response;
	},
};
