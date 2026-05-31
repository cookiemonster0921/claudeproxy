/**
 * Register all Discord slash commands for the Claude Proxy bot.
 * Run once (or whenever commands change):
 *   npx tsx scripts/register-discord-commands.mts
 * Or: npm run discord:register
 *
 * Reads DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID from .dev.vars (then env vars as fallback).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDevVars(): Record<string, string> {
	try {
		const raw = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf8');
		const vars: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			const value = trimmed.slice(eq + 1).trim();
			if (key) vars[key] = value;
		}
		return vars;
	} catch {
		return {};
	}
}

const devVars = loadDevVars();

const APPLICATION_ID = devVars.DISCORD_APPLICATION_ID ?? process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = devVars.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
	console.error('Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN — set them in .dev.vars or as env vars');
	process.exit(1);
}

const STR = 3; // STRING option type
const INT = 4; // INTEGER option type
const SUB = 1; // SUB_COMMAND option type (unused but kept for clarity)

const EFFORT_CHOICES = [
	{ name: 'auto (default)', value: 'auto' },
	{ name: 'low (brief)', value: 'low' },
	{ name: 'medium', value: 'medium' },
	{ name: 'high (detailed)', value: 'high' },
	{ name: 'xhigh (thorough)', value: 'xhigh' },
	{ name: 'max (exhaustive)', value: 'max' },
];

const commands = [
	// -------------------------------------------------------------------------
	// Core — no AI call
	// -------------------------------------------------------------------------
	{
		name: 'ask',
		description: 'Send a message to Claude (maintains conversation history)',
		options: [{ type: STR, name: 'message', description: 'Your message', required: true }],
	},
	{
		name: 'status',
		description: 'Show current session info: model, effort, goal, message count',
	},
	{
		name: 'model',
		description: 'Set the AI model for this channel (interactive provider + model picker)',
	},
	{
		name: 'effort',
		description: 'Set the effort/depth level for Claude responses',
		options: [{
			type: STR, name: 'level', description: 'Effort level', required: true,
			choices: EFFORT_CHOICES,
		}],
	},
	{
		name: 'context',
		description: 'Show estimated context usage and token stats',
	},
	{
		name: 'goal',
		description: 'Set a persistent objective that is added to the system prompt',
		options: [{ type: STR, name: 'text', description: 'Your goal or objective', required: true }],
	},
	{
		name: 'export',
		description: 'Export the conversation transcript',
		options: [{
			type: STR, name: 'format', description: 'Format', required: false,
			choices: [{ name: 'Markdown (default)', value: 'md' }, { name: 'Plain text', value: 'txt' }],
		}],
	},
	{
		name: 'help',
		description: 'Show all available commands and buttons',
	},

	// -------------------------------------------------------------------------
	// Core — AI call
	// -------------------------------------------------------------------------
	{
		name: 'compact',
		description: 'Summarize and compact the current conversation history',
		options: [{ type: STR, name: 'instructions', description: 'Optional compaction instructions', required: false }],
	},
	{
		name: 'plan',
		description: 'Generate a detailed implementation plan',
		options: [{ type: STR, name: 'description', description: 'What to plan', required: false }],
	},
	{
		name: 'review',
		description: 'Perform a code or architecture review',
		options: [{ type: STR, name: 'target', description: 'What to review (paste code or describe)', required: false }],
	},
	{
		name: 'code-review',
		description: 'Structured code review with critical/style/performance sections',
		options: [{ type: STR, name: 'target', description: 'Code to review', required: false }],
	},
	{
		name: 'security-review',
		description: 'Security-focused review (OWASP, injection, auth, secrets)',
		options: [{ type: STR, name: 'target', description: 'Code or system to review', required: false }],
	},
	{
		name: 'recap',
		description: 'Summarize this session in 3–5 bullet points',
	},
	{
		name: 'qa',
		description: 'QA analysis: identify unverified assumptions, bugs, missing tests',
	},
	{
		name: 'verify',
		description: 'Ask Claude to verify a specific claim or assumption',
		options: [{ type: STR, name: 'claim', description: 'The claim to verify', required: true }],
	},
	{
		name: 'insights',
		description: 'Show proxy analytics: requests, costs, latency, model usage',
	},
	{
		name: 'loop',
		description: 'Run a repeated workflow loop (use Stop button to cancel)',
		options: [
			{ type: STR, name: 'prompt', description: 'Prompt to repeat', required: true },
			{ type: INT, name: 'max_iterations', description: 'Max iterations (default 3, max 10)', required: false },
		],
	},

	// -------------------------------------------------------------------------
	// Admin commands
	// -------------------------------------------------------------------------
	{
		name: 'agents',
		description: '[Admin] Show provider availability and routing info',
	},
	{
		name: 'mcp',
		description: '[Admin] Show MCP server configuration',
	},
	{
		name: 'memory',
		description: '[Admin] Show session memory and storage usage',
	},
	{
		name: 'hooks',
		description: '[Admin] List configured webhook integrations',
	},
	{
		name: 'batch',
		description: '[Admin] Run a prompt against multiple models and compare',
		options: [{ type: STR, name: 'prompt', description: 'Prompt to batch', required: true }],
	},
	{
		name: 'debug',
		description: '[Admin] Show full session state and settings resolution',
	},
	{
		name: 'fewer-permission-prompts',
		description: '[Admin] Info on permission prompt settings',
	},
	{
		name: 'run',
		description: '[Admin] Execute a named workflow',
		options: [
			{ type: STR, name: 'workflow', description: 'Workflow: plan/review/code-review/security-review/qa/recap', required: true },
			{ type: STR, name: 'target', description: 'Optional target description', required: false },
		],
	},
	{
		name: 'run-skill-generator',
		description: '[Admin] Generate a workflow definition from a description',
		options: [{ type: STR, name: 'description', description: 'Describe the workflow', required: false }],
	},
	{
		name: 'team-onboarding',
		description: '[Admin] Return team onboarding guide',
	},
	{
		name: 'updateconfig',
		description: '[Admin] Update a session or project config key',
		options: [
			{ type: STR, name: 'key', description: 'Config key: model, effort, goal', required: true },
			{ type: STR, name: 'value', description: 'New value', required: true },
		],
	},

	// -------------------------------------------------------------------------
	// Cloud agent commands
	// -------------------------------------------------------------------------
	{
		name: 'cloudrun',
		description: '[Admin] Execute a goal with full Claude Code in a Cloud Run container',
		options: [
			{ type: STR, name: 'goal', description: 'What to accomplish', required: true },
			{ type: STR, name: 'model', description: 'Model override (e.g. claude-sonnet-4-6)', required: false },
		],
	},
	{
		name: 'agent',
		description: '[Admin] Run a goal with the cloud-native Cloudflare agent (no local machine needed)',
		options: [
			{ type: STR, name: 'goal', description: 'Goal to accomplish', required: true },
		],
	},
	{
		name: 'agentstop',
		description: '[Admin] Stop the running cloud agent in this channel',
	},
	{
		name: 'agentclear',
		description: '[Admin] Clear cloud agent conversation history so the next /agent starts fresh',
	},
];

console.log(`Registering ${commands.length} commands for application ${APPLICATION_ID}...`);

const res = await fetch(
	`https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`,
	{
		method: 'PUT',
		headers: {
			Authorization: `Bot ${BOT_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(commands),
	},
);

const data = await res.json();
if (res.ok) {
	console.log(`✅ Registered ${(data as unknown[]).length} command(s) successfully.`);
	console.log('Commands:', (data as Array<{ name: string }>).map((c) => `/${c.name}`).join(', '));
} else {
	console.error('❌ Failed to register commands:');
	console.error(JSON.stringify(data, null, 2));
	process.exit(1);
}
