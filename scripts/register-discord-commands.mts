/**
 * Register the Discord slash commands for the operations bot.
 * Run once (or whenever commands change):
 *   npx tsx scripts/register-discord-commands.mts
 * Or: npm run discord:register
 *
 * Reads OPS_BOT_TOKEN and OPS_BOT_APPLICATION_ID from .dev.vars
 * (then environment variables as fallback).
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

const APPLICATION_ID = devVars.OPS_BOT_APPLICATION_ID ?? process.env.OPS_BOT_APPLICATION_ID;
const BOT_TOKEN = devVars.OPS_BOT_TOKEN ?? process.env.OPS_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
	console.error('Missing OPS_BOT_APPLICATION_ID or OPS_BOT_TOKEN - set them in .dev.vars or as env vars');
	process.exit(1);
}

const commands = [
	{
		name: 'cloudshell',
		description: 'Launch a temporary Claude Code Discord session in Google Cloud Shell',
	},
	{
		name: 'computeengine',
		description: 'Launch a Claude Code Discord session on Google Compute Engine (GCE)',
	},
	{
		name: 'oracle',
		description: 'Launch a Claude Code Discord session on Oracle Cloud Infrastructure (OCI)',
	},
	{
		name: 'cloudrunjobs',
		description: 'Launch an experimental time-limited Claude Code Discord session as a Cloud Run Job',
	},
	{
		name: 'modal',
		description: 'Launch a Claude Code Discord session on Modal (serverless, always-on container)',
	},
	{
		name: 'northflank',
		description: 'Launch a Claude Code Discord session on Northflank (persistent container service)',
	},
	{
		name: 'local',
		description: 'Launch a Claude Code Discord session on a configured local runtime',
	},
	{
		name: 'macstudio',
		description: 'Launch a Claude Code Discord session on Mac Studio (always-on, tmux background)',
	},
	{
		name: 'help',
		description: 'Show the operations bot help panel',
	},
].map((command) => ({
	...command,
	type: 1,
	integration_types: [0],
	contexts: [0],
}));

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
