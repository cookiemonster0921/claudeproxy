/**
 * trigger-local-session.mts — Send a launch command directly to the
 * discord_session_launcher.py daemon without going through Discord.
 *
 * Useful for:
 *   • Testing the daemon end-to-end from the command line
 *   • Scripting local session launches in CI / shell scripts
 *   • Verifying the daemon is connected before issuing a Discord /local command
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *
 *   # Check how many daemons are connected
 *   npx tsx scripts/trigger-local-session.mts --status
 *
 *   # Launch a session for Discord channel 1234 allowed only to user 9876
 *   npx tsx scripts/trigger-local-session.mts \
 *     --channel-id 1234567890123456789 \
 *     --users 750640430416265267 \
 *     --model google_ai/gemini-2.5-flash
 *
 *   # Target a local Wrangler dev server instead of prod
 *   WORKER_URL=http://localhost:8787 npx tsx scripts/trigger-local-session.mts --status
 *
 * Reads WORKER_URL and PROXY_TOKEN from .dev.vars (same file as cproxy/deploy scripts).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Config ─────────────────────────────────────────────────────────────────────

function loadDevVars(): Record<string, string> {
	try {
		const raw = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf8');
		const out: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			const eq = t.indexOf('=');
			if (eq < 0) continue;
			const k = t.slice(0, eq).trim();
			const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
			if (k) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

const dv = loadDevVars();
const WORKER_URL = (process.env.WORKER_URL ?? dv.WORKER_URL ?? '').replace(/\/$/, '');
const PROXY_TOKEN = process.env.PROXY_TOKEN ?? dv.PROXY_TOKEN ?? '';

if (!WORKER_URL) {
	console.error('ERROR: WORKER_URL not set. Add it to .dev.vars or: export WORKER_URL=...');
	process.exit(1);
}

// ── CLI args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name: string): string | null {
	const i = args.indexOf(name);
	return i >= 0 ? (args[i + 1] ?? null) : null;
}

const channelId  = flag('--channel-id');
const userIds    = flag('--users') ?? flag('--discord-users') ?? '';
const modelId    = flag('--model') ?? '';
const statusOnly = args.includes('--status');
const help       = args.includes('--help') || args.includes('-h');

if (help || args.length === 0) {
	console.log([
		'trigger-local-session.mts — dispatch a launch command to the local daemon',
		'',
		'Usage:',
		'  npx tsx scripts/trigger-local-session.mts --status',
		'  npx tsx scripts/trigger-local-session.mts --channel-id ID [--users ID,...] [--model MODEL]',
		'',
		'Flags:',
		'  --status              Show how many daemons are connected',
		'  --channel-id  ID      Discord channel ID the session should listen to',
		'  --users       ID,...  Comma-separated Discord user IDs allowed to send messages',
		'  --model       MODEL   Provider/model override (e.g. google_ai/gemini-2.5-flash)',
		'',
		'Config (from .dev.vars or env):',
		`  WORKER_URL    ${WORKER_URL || '(not set)'}`,
		`  PROXY_TOKEN   ${PROXY_TOKEN ? '(set)' : '(not set)'}`,
	].join('\n'));
	process.exit(0);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

const authHeaders: Record<string, string> = {
	'Content-Type': 'application/json',
	...(PROXY_TOKEN ? { Authorization: `Bearer ${PROXY_TOKEN}` } : {}),
};

async function workerFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${WORKER_URL}${path}`, {
		...init,
		headers: { ...authHeaders, ...((init?.headers as Record<string, string>) ?? {}) },
	});
	const text = await res.text();
	let body: T;
	try { body = JSON.parse(text) as T; }
	catch { throw new Error(`HTTP ${res.status}: ${text}`); }
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
	return body;
}

// ── Status ──────────────────────────────────────────────────────────────────────

if (statusOnly) {
	console.log(`Checking ${WORKER_URL}/launcher-status …`);
	const s = await workerFetch<{ connected_daemons: number; pending_configs: number; configured?: boolean }>('/launcher-status');
	if (s.configured === false) {
		console.log('⚠️  LAUNCHER_DO is not configured on the Worker.');
		console.log('   Deploy with: wrangler deploy');
	} else {
		const icon = s.connected_daemons > 0 ? '✅' : '⚠️ ';
		console.log(`${icon} Connected daemons : ${s.connected_daemons}`);
		console.log(`   Pending configs   : ${s.pending_configs}`);
		if (s.connected_daemons === 0) {
			console.log('\n   Start the daemon on your local machine:');
			console.log('     python3 discord_session_launcher.py');
		}
	}
	process.exit(0);
}

// ── Launch ──────────────────────────────────────────────────────────────────────

if (!channelId) {
	console.error('ERROR: --channel-id is required. Run with --help for usage.');
	process.exit(1);
}

// Build the cproxy command (same logic as opsInteractions.ts buildCproxyCommand)
const commandParts = [
	'claude-proxy.sh on prod',
	'--channels "plugin:discord@claude-plugins-official"',
	`--discord-channel ${channelId}`,
];
if (userIds)  commandParts.push(`--discord-users ${userIds}`);
if (modelId)  commandParts.push(`--model ${modelId}`);
const command = commandParts.join(' \\\n  ');
const sessionId = Math.random().toString(36).slice(2, 10);

console.log('');
console.log('  Local session launch');
console.log(`  Worker  : ${WORKER_URL}`);
console.log(`  Channel : ${channelId}`);
console.log(`  Users   : ${userIds || '(anyone)'}`);
console.log(`  Model   : ${modelId || '(default)'}`);
console.log('');
console.log('  Command sent to daemon:');
console.log('  ' + '─'.repeat(56));
console.log(command.split('\n').map((l) => `  ${l}`).join('\n'));
console.log('  ' + '─'.repeat(56));
console.log('');

// POST /launcher-dispatch dispatches directly — no Discord interaction needed.
const result = await workerFetch<{ ok: boolean; sent: number; connected: number; error?: string }>(
	'/launcher-dispatch',
	{
		method: 'POST',
		body: JSON.stringify({ command, session_id: sessionId }),
	},
);

if (result.ok && result.sent > 0) {
	console.log(`  ✅ Dispatched to ${result.sent} daemon${result.sent === 1 ? '' : 's'}.`);
	console.log('     A new terminal tab should open on your local machine within seconds.');
} else if (result.connected === 0) {
	console.warn('  ⚠️  No daemons received the command — none are connected.');
	console.warn('     Start discord_session_launcher.py on your local machine and retry.');
	process.exit(1);
} else {
	console.error('  ❌ Unexpected result:', JSON.stringify(result));
	process.exit(1);
}
