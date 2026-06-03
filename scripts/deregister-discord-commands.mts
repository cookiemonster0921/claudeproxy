/**
 * Deregister all global Discord slash commands for the operations bot.
 * Run:
 *   npx tsx scripts/deregister-discord-commands.mts
 * Or:
 *   npm run discord:deregister
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

console.log(`Deregistering all global commands for application ${APPLICATION_ID}...`);

const res = await fetch(
	`https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`,
	{
		method: 'PUT',
		headers: {
			Authorization: `Bot ${BOT_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify([]),
	},
);

const data = await res.json();
if (res.ok) {
	console.log(`Deregistered all global commands. Discord returned ${(data as unknown[]).length} command(s).`);
} else {
	console.error('Failed to deregister commands:');
	console.error(JSON.stringify(data, null, 2));
	process.exit(1);
}
