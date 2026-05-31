// Cloud Run HTTP server — receives goals from Discord, runs them with Claude Code

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeMcpConfig } from './mcp-config.js';
import { startRun, stopRun, getActiveRunIds } from './runner.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const CONTAINER_SECRET = process.env.CONTAINER_SECRET;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function checkAuth(req: IncomingMessage): boolean {
	if (!CONTAINER_SECRET) return true; // no auth required if secret not set
	const auth = req.headers['authorization'];
	return auth === `Bearer ${CONTAINER_SECRET}`;
}

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(data);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const raw = await readBody(req);
	let body: { goal?: string; channel_id?: string; model?: string; run_id?: string; max_turns?: number };
	try {
		body = JSON.parse(raw);
	} catch {
		json(res, 400, { error: 'Invalid JSON body' });
		return;
	}

	const { goal, channel_id, model, run_id, max_turns } = body;
	if (!goal || typeof goal !== 'string') {
		json(res, 400, { error: 'goal is required' });
		return;
	}
	if (!channel_id || typeof channel_id !== 'string') {
		json(res, 400, { error: 'channel_id is required' });
		return;
	}

	const runId = run_id ?? crypto.randomUUID();
	console.log(`[server] POST /run runId=${runId.slice(0, 8)} channel=${channel_id} goal="${goal.slice(0, 80)}"`);

	// Fire-and-forget — response is 202 immediately
	startRun({ runId, goal, channelId: channel_id, model, maxTurns: max_turns }).catch((e: Error) => {
		console.error(`[server] startRun error:`, e.message);
	});

	json(res, 202, { run_id: runId, status: 'started' });
}

function handleStop(req: IncomingMessage, res: ServerResponse, runId: string): void {
	const stopped = stopRun(runId);
	json(res, 200, { run_id: runId, stopped });
}

function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
	json(res, 200, {
		ok: true,
		active_runs: getActiveRunIds().length,
		run_ids: getActiveRunIds().map((id) => id.slice(0, 8)),
	});
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = req.url ?? '/';
	const method = req.method ?? 'GET';

	// CORS preflight
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	if (method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	// Auth check (skip health)
	if (url !== '/health' && !checkAuth(req)) {
		json(res, 401, { error: 'Unauthorized' });
		return;
	}

	if (method === 'GET' && url === '/health') {
		json(res, 200, { ok: true, service: 'claude-agent-container' });
		return;
	}

	if (method === 'GET' && url === '/status') {
		handleStatus(req, res);
		return;
	}

	if (method === 'POST' && url === '/run') {
		await handleRun(req, res);
		return;
	}

	const stopMatch = /^\/stop\/([a-zA-Z0-9-]+)$/.exec(url);
	if (method === 'POST' && stopMatch) {
		handleStop(req, res, stopMatch[1]);
		return;
	}

	json(res, 404, { error: `Not found: ${method} ${url}` });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Write MCP config before starting server
writeMcpConfig(process.env.VALTOWN_API_KEY);

const server = createServer((req, res) => {
	handleRequest(req, res).catch((e: Error) => {
		console.error('[server] Unhandled error:', e.message);
		try {
			json(res, 500, { error: e.message });
		} catch {
			// response may already be closed
		}
	});
});

server.listen(PORT, () => {
	console.log(`[server] Claude agent container listening on port ${PORT}`);
	console.log(`[server] Auth: ${CONTAINER_SECRET ? 'enabled' : 'disabled (no CONTAINER_SECRET)'}`);
});
