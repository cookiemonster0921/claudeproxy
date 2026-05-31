import type { Session } from '../sessions/sessionStore';
import type { ProjectSettings } from '../projects/projectSettings';
import type { ResolvedSettings } from '../sessions/settingsResolver';
import { effortDescription } from '../sessions/settingsResolver';

const DISCORD_MAX = 1900;

export function formatResponse(text: string, model: string, durationMs: number): string {
	const header = `**Claude** (\`${model}\`, ${durationMs}ms)\n\n`;
	const body = text.length > DISCORD_MAX ? text.slice(0, DISCORD_MAX) + '\n…*(truncated)*' : text;
	return header + body;
}

export function formatError(message: string): string {
	return `⚠️ **Error:** ${message}`;
}

export function formatStatus(
	session: Session | null,
	messageCount: number,
	settings: ResolvedSettings,
): string {
	if (!session) {
		return '❌ No active session in this channel. Use `/ask` to begin.';
	}
	const lines = [
		'**Session Status**',
		`Status: ${session.status}`,
		`Model: \`${settings.model}\``,
		`Effort: ${effortDescription(settings.effortLevel)}`,
	];
	if (session.goal) lines.push(`Goal: *${session.goal}*`);
	if (session.projectName) lines.push(`Project: \`${session.projectName}\``);
	lines.push(`Messages in history: ${messageCount}`);
	return lines.join('\n');
}

export function formatHelp(): string {
	return [
		'**Claude Proxy — Discord Commands**',
		'',
		'`/ask <message>` — Chat with Claude (maintains conversation history)',
		'`/status` — Show session info, model, effort',
		'`/model <model>` — Set model for this channel',
		'`/effort <level>` — Set effort: low/medium/high/xhigh/max/auto',
		'`/context` — Show token usage and history stats',
		'`/goal <text>` — Set a persistent objective',
		'`/compact [instructions]` — Summarize and compact conversation',
		'`/plan <description>` — Generate an implementation plan',
		'`/review [target]` — Code/architecture review',
		'`/code-review <target>` — Structured code review',
		'`/security-review <target>` — Security-focused review',
		'`/recap` — Summarize this session in bullet points',
		'`/export [format]` — Export transcript (txt or md)',
		'`/qa` — Run QA analysis',
		'`/verify <claim>` — Verify a specific claim',
		'`/loop <prompt> [max] [interval]` — Repeated workflow',
		'`/insights` — Analytics dashboard',
		'`/help` — Show this message',
		'',
		'**Admin** *(role-restricted)*',
		'`/agents` `/mcp` `/memory` `/debug` `/batch` `/run` `/updateconfig` and more',
		'',
		'**Buttons** (appear after /ask responses)',
		'▶️ Continue · 🔄 Retry · 💪 Stronger · ℹ️ Status · 📝 Recap',
	].join('\n');
}

export function formatSettings(
	session: Session | null,
	project: ProjectSettings | null,
	settings: ResolvedSettings,
	globalModel: string | undefined,
): string {
	return [
		'**Current Settings**',
		`Resolved model: \`${settings.model}\``,
		`Global default: \`${globalModel ?? 'claude-sonnet-4-6'}\``,
		`Project default: ${project?.defaultModel ? `\`${project.defaultModel}\`` : '*(none)*'}`,
		`Session override: ${session?.modelOverride ? `\`${session.modelOverride}\`` : '*(none)*'}`,
		`Effort: ${effortDescription(settings.effortLevel)}`,
		`Project: ${session?.projectName ? `\`${session.projectName}\`` : '*(none)*'}`,
		`Message storage: ${project ? '*(project settings)*' : '*(global)*'}`,
	].join('\n');
}
