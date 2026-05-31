// Write ~/.claude/settings.json with MCP server config at startup

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function writeMcpConfig(valtownApiKey?: string): void {
	const claudeDir = join(homedir(), '.claude');
	mkdirSync(claudeDir, { recursive: true });

	const mcpServers: Record<string, unknown> = {};

	if (valtownApiKey) {
		mcpServers['valtown'] = {
			type: 'http',
			url: 'https://mcp.val.town',
			headers: {
				Authorization: `Bearer ${valtownApiKey}`,
			},
		};
	}

	const settings = {
		mcpServers,
		// Disable telemetry
		autoUpdates: false,
	};

	const settingsPath = join(claudeDir, 'settings.json');
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	console.log(`[mcp-config] Wrote settings to ${settingsPath}`);
}
