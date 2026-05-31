import { editFollowup, sendFollowup, EMBED_COLOR_AI, EMBED_COLOR_ERROR } from './discordApi';
import type { DiscordActionRow, DiscordButton, DiscordEmbed } from './discordTypes';
import { ButtonStyle } from './discordTypes';

// Discord embed description limit
const EMBED_LIMIT = 4000;
// Fallback plain-text limit (used for non-embed paths)
const DISCORD_LIMIT = 1990;

export function splitMessage(text: string): string[] {
	if (text.length <= DISCORD_LIMIT) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > DISCORD_LIMIT) {
		// Try to split on a double newline (paragraph boundary)
		let cutAt = remaining.lastIndexOf('\n\n', DISCORD_LIMIT);
		if (cutAt < DISCORD_LIMIT / 2) {
			// Fall back to single newline
			cutAt = remaining.lastIndexOf('\n', DISCORD_LIMIT);
		}
		if (cutAt < DISCORD_LIMIT / 2) {
			// Fall back to space
			cutAt = remaining.lastIndexOf(' ', DISCORD_LIMIT);
		}
		if (cutAt <= 0) {
			// Hard cut as last resort
			cutAt = DISCORD_LIMIT;
		}
		chunks.push(remaining.slice(0, cutAt).trimEnd());
		remaining = remaining.slice(cutAt).trimStart();
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

export function buildActionRow(channelId: string, includeStop = false): DiscordActionRow {
	const buttons: DiscordButton[] = [
		{ type: 2 as const, style: ButtonStyle.Primary, label: 'Continue', custom_id: `continue:${channelId}`, emoji: { name: '▶️' } },
		{ type: 2 as const, style: ButtonStyle.Secondary, label: 'Retry', custom_id: `retry:${channelId}`, emoji: { name: '🔄' } },
		{ type: 2 as const, style: ButtonStyle.Secondary, label: 'Stronger', custom_id: `stronger:${channelId}`, emoji: { name: '💪' } },
		{ type: 2 as const, style: ButtonStyle.Secondary, label: 'Status', custom_id: `status:${channelId}`, emoji: { name: 'ℹ️' } },
		{ type: 2 as const, style: ButtonStyle.Secondary, label: 'Recap', custom_id: `recap:${channelId}`, emoji: { name: '📝' } },
	];

	if (includeStop) {
		buttons.splice(2, 0, {
			type: 2 as const,
			style: ButtonStyle.Danger,
			label: 'Stop',
			custom_id: `stop:${channelId}`,
			emoji: { name: '⏹️' },
		});
	}

	// Discord action rows max 5 buttons
	return { type: 1, components: buttons.slice(0, 5) };
}

/**
 * Parse the "**Claude** (`model`, 123ms)\n\n body" format produced by handleAsk et al.
 * Returns { header, body } so we can put the header in the embed footer and body in description.
 */
function parseResponseText(text: string): { footer: string; body: string } {
	// Match: **Claude** (`model`, Nms)\n\nbody
	const match = text.match(/^\*\*(.+?)\*\*\s*\(([^)]+)\)\s*\n\n([\s\S]*)$/);
	if (match) {
		return { footer: `${match[1]} • ${match[2]}`, body: match[3].trim() };
	}
	// Fallback: no header detected
	return { footer: '', body: text };
}

/** Send the main AI response as a Discord embed with action buttons. */
export async function sendFollowupWithButtons(
	applicationId: string,
	token: string,
	text: string,
	channelId: string,
	includeStop = false,
): Promise<void> {
	const actionRow = buildActionRow(channelId, includeStop);
	const { footer, body } = parseResponseText(text);

	if (body.length <= EMBED_LIMIT) {
		const embed: DiscordEmbed = {
			description: body,
			color: EMBED_COLOR_AI,
			...(footer ? { footer: { text: footer } } : {}),
		};
		await editFollowup(applicationId, token, '', [actionRow], [embed]);
		return;
	}

	// Body too long for one embed — split into chunks, last one gets buttons
	const chunks = splitMessage(body);
	const firstEmbed: DiscordEmbed = { description: chunks[0], color: EMBED_COLOR_AI };
	await editFollowup(applicationId, token, '', [], [firstEmbed]);

	for (let i = 1; i < chunks.length - 1; i++) {
		const embed: DiscordEmbed = { description: chunks[i], color: EMBED_COLOR_AI };
		await sendFollowup(applicationId, token, '', [], [embed]);
	}

	const lastEmbed: DiscordEmbed = {
		description: chunks[chunks.length - 1],
		color: EMBED_COLOR_AI,
		...(footer ? { footer: { text: footer } } : {}),
	};
	await sendFollowup(applicationId, token, '', [actionRow], [lastEmbed]);
}

export async function sendError(applicationId: string, token: string, message: string): Promise<void> {
	const embed: DiscordEmbed = {
		description: `⚠️ **Error:** ${message}`,
		color: EMBED_COLOR_ERROR,
	};
	await editFollowup(applicationId, token, '', [], [embed]);
}

