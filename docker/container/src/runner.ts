// Claude Code subprocess management with session continuation.
//
// Strategy:
//   1. Run with --output-format stream-json to capture structured events.
//   2. Parse the session_id from the init/result event.
//   3. Keep an in-memory map: channelId → sessionId (fast path, same instance).
//   4. Also persist session ID + summary to the proxy's D1 via session-store
//      (slow path — survives container restarts).
//   5. On next run for same channel:
//      a) Try --resume <sessionId> (in-memory or restored from proxy).
//      b) If no session known, start fresh (proxy summary is prepended as context).

import { spawn, type ChildProcess } from 'node:child_process';
import { sendChannelMessage, sendProgressUpdate } from './discord.js';
import { loadSession, saveSession } from './session-store.js';

export interface RunOptions {
	runId: string;
	goal: string;
	channelId: string;
	model?: string;
	maxTurns?: number;
}

interface ActiveRun {
	proc: ChildProcess;
	startedAt: Date;
	goal: string;
}

// ---------------------------------------------------------------------------
// Per-instance session memory: channel_id → claude session_id
// Survives multiple runs within the same container instance.
// ---------------------------------------------------------------------------
const channelSessions = new Map<string, string>();

// Active subprocess map
const activeRuns = new Map<string, ActiveRun>();

export function getActiveRunIds(): string[] {
	return [...activeRuns.keys()];
}

export function stopRun(runId: string): boolean {
	const run = activeRuns.get(runId);
	if (!run) return false;
	run.proc.kill('SIGTERM');
	activeRuns.delete(runId);
	return true;
}

// ---------------------------------------------------------------------------
// Session ID extraction from --output-format stream-json
// Claude Code emits NDJSON events; the session_id appears in the "system/init"
// event and again in the "result" event.
// ---------------------------------------------------------------------------
function extractSessionId(line: string): string | null {
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		if (typeof event.session_id === 'string' && event.session_id) {
			return event.session_id;
		}
	} catch {
		// Not JSON — ignore
	}
	return null;
}

// Strip NDJSON envelope and return the human-readable result text (if present).
function extractResultText(line: string): string | null {
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		if (event.type === 'result' && typeof event.result === 'string') {
			return event.result;
		}
	} catch {
		// Not JSON
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main run function
// ---------------------------------------------------------------------------
export async function startRun(options: RunOptions): Promise<void> {
	const { runId, goal, channelId, model = 'claude-sonnet-4-6' } = options;

	const botToken = process.env.DISCORD_BOT_TOKEN;
	const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
	const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;

	if (!botToken) throw new Error('DISCORD_BOT_TOKEN is required');

	// ------------------------------------------------------------------
	// Look up prior session for this channel (in-memory first, then D1)
	// ------------------------------------------------------------------
	let resumeSessionId: string | undefined = channelSessions.get(channelId);
	let isResume = false;
	let contextSummary: string | undefined;

	if (!resumeSessionId) {
		// Cross-instance path: check D1 via proxy
		const stored = await loadSession(channelId);
		if (stored?.cr_session_id) {
			resumeSessionId = stored.cr_session_id;
			contextSummary = stored.cr_summary ?? undefined;
		}
	}

	// ------------------------------------------------------------------
	// Build claude args
	// ------------------------------------------------------------------
	let effectiveGoal = goal;

	if (resumeSessionId) {
		// We have a session ID — use --resume
		isResume = true;
		console.log(`[runner:${runId.slice(0, 8)}] Resuming session ${resumeSessionId.slice(0, 12)} for channel ${channelId}`);
	} else if (contextSummary) {
		// No session ID but we have a summary from a previous (different) instance
		effectiveGoal = `[Continuing from previous session]\nPrevious context:\n${contextSummary}\n\nNew task: ${goal}`;
		console.log(`[runner:${runId.slice(0, 8)}] Injecting prior context for channel ${channelId}`);
	}

	const args: string[] = [
		'--dangerously-skip-permissions',
		'--print',
		'--output-format', 'stream-json',
		'--model', model,
	];
	if (resumeSessionId) {
		args.push('--resume', resumeSessionId);
	}
	args.push(effectiveGoal);

	// ------------------------------------------------------------------
	// Environment
	// ------------------------------------------------------------------
	const claudeEnv: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_CODE_SKIP_TELEMETRY: '1',
	};
	if (anthropicBaseUrl) claudeEnv.ANTHROPIC_BASE_URL = anthropicBaseUrl;
	if (anthropicToken) {
		claudeEnv.ANTHROPIC_API_KEY = anthropicToken;
		claudeEnv.ANTHROPIC_AUTH_TOKEN = anthropicToken;
	}

	console.log(`[runner:${runId.slice(0, 8)}] Starting claude model=${model} resume=${isResume} goal="${goal.slice(0, 80)}"`);

	const proc = spawn('claude', args, {
		env: claudeEnv,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	activeRuns.set(runId, { proc, startedAt: new Date(), goal });

	// ------------------------------------------------------------------
	// Output parsing
	// ------------------------------------------------------------------
	let capturedSessionId: string | undefined;
	let humanOutput = '';       // extracted result text from stream-json events
	let rawLines = '';          // fallback: all stdout lines for progress/summary
	let lastProgressAt = Date.now();
	const PROGRESS_INTERVAL_MS = 60_000;

	proc.stdout?.on('data', (chunk: Buffer) => {
		const text = chunk.toString();
		rawLines += text;
		process.stdout.write(text);

		// Parse NDJSON lines for session ID and result text
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			const sid = extractSessionId(trimmed);
			if (sid && !capturedSessionId) {
				capturedSessionId = sid;
				channelSessions.set(channelId, sid); // cache in memory immediately
				console.log(`[runner:${runId.slice(0, 8)}] Captured session_id=${sid.slice(0, 12)}`);
			}

			const resultText = extractResultText(trimmed);
			if (resultText) humanOutput = resultText;
		}

		// Periodic progress update
		if (Date.now() - lastProgressAt > PROGRESS_INTERVAL_MS) {
			lastProgressAt = Date.now();
			const preview = (humanOutput || rawLines).slice(-1000);
			sendProgressUpdate(botToken, channelId, runId, preview).catch((e) =>
				console.error(`[runner:${runId.slice(0, 8)}] Progress failed:`, e),
			);
		}
	});

	proc.stderr?.on('data', (chunk: Buffer) => {
		process.stderr.write(chunk);
	});

	proc.on('exit', async (code, signal) => {
		activeRuns.delete(runId);
		console.log(`[runner:${runId.slice(0, 8)}] Exit code=${code} signal=${signal} session=${capturedSessionId?.slice(0, 12) ?? 'none'}`);

		// Persist session to D1 for future container instances
		const summary = (humanOutput || rawLines).trim().slice(-500);
		await saveSession(channelId, capturedSessionId, summary);

		// Build Discord message
		const output = (humanOutput || rawLines).trim();
		const preview = output.length > 1800 ? output.slice(-1800) : output;
		const status = code === 0 ? '✅' : '⚠️';
		const exitInfo = signal ? `signal=${signal}` : `exit=${code}`;
		const resumeNote = isResume ? ' *(resumed)*' : '';

		const message = [
			`${status} **Agent done** (\`${runId.slice(0, 8)}\`) [${exitInfo}]${resumeNote}`,
			'',
			preview || '*(no output)*',
		].join('\n');

		await sendChannelMessage(botToken, channelId, message).catch((e) =>
			console.error(`[runner:${runId.slice(0, 8)}] Final message failed:`, e),
		);
	});

	proc.on('error', async (err) => {
		activeRuns.delete(runId);
		console.error(`[runner:${runId.slice(0, 8)}] Process error:`, err.message);
		await sendChannelMessage(
			botToken,
			channelId,
			`❌ **Agent failed to start** (\`${runId.slice(0, 8)}\`)\n${err.message}`,
		).catch(() => {});
	});
}
