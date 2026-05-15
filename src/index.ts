// Anthropic-compatible Claude Code proxy — routes to multiple LLM providers

import type { Env, MessagesRequest } from './types';
import { CORS_HEADERS, jsonResponse, jsonError, stringifySystem, approxTokens } from './types';
import { loadSettings } from './config';
import { ProxyError } from './error';
import { WORKERS_AI_MODEL_MAP } from './model-router';
import { ProxyService } from './proxy-service';

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleHealth(requestId: string): Response {
	return jsonResponse({ ok: true, service: 'claude-code-cf-proxy' }, requestId);
}

function handleModels(requestId: string): Response {
	const created = Math.floor(Date.now() / 1000);
	// Claude Code gateway discovery only accepts IDs starting with "claude" or "anthropic"
	const data = Object.keys(WORKERS_AI_MODEL_MAP)
		.filter((id) => id.startsWith('claude') || id.startsWith('anthropic'))
		.map((id) => ({
			id,
			object: 'model',
			created,
			owned_by: 'cloudflare',
			display_name: id,
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
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const requestId = crypto.randomUUID();
		const startTime = Date.now();
		const url = new URL(request.url);
		const { method } = request;
		const { pathname } = url;

		console.log(
			JSON.stringify({ event: 'request', requestId, method, path: pathname, ts: new Date().toISOString() }),
		);

		if (method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const authError = checkAuth(request, env);
		if (authError) return authError;

		let response: Response;
		try {
			if (method === 'GET' && pathname === '/health') {
				response = handleHealth(requestId);
			} else if (method === 'GET' && pathname === '/v1/models') {
				response = handleModels(requestId);
			} else if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
				response = await handleCountTokens(request, requestId);
			} else if (method === 'POST' && pathname === '/v1/messages') {
				const body = (await request.json()) as MessagesRequest;
				const settings = loadSettings(env);
				const service = new ProxyService(settings, env);
				response = await service.handleMessages(body, requestId);
			} else {
				response = jsonError(404, 'not_found', `Unknown endpoint: ${method} ${pathname}`, requestId);
			}
		} catch (err) {
			if (err instanceof ProxyError) {
				response = jsonError(err.status, err.errorType, err.message, requestId);
			} else {
				const message = err instanceof Error ? err.message : 'Internal server error';
				console.error(`[${requestId}] Unhandled error:`, message);
				response = jsonError(500, 'api_error', message, requestId);
			}
		}

		// approxTokens is only available for count_tokens; log duration for all other routes
		void approxTokens; // imported for use in count_tokens handler
		console.log(
			JSON.stringify({ event: 'response', requestId, status: response.status, duration: Date.now() - startTime }),
		);
		return response;
	},
};
