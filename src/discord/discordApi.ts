const DISCORD_API = 'https://discord.com/api/v10';

// Anthropic purple
export const EMBED_COLOR_AI    = 0x7c3aed;
// Muted grey for non-AI responses (status, help, etc.)
export const EMBED_COLOR_INFO  = 0x5865f2;
// Red for errors
export const EMBED_COLOR_ERROR = 0xed4245;

export interface MessagePayload {
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
}

async function discordPatch(url: string, body: MessagePayload): Promise<void> {
	const res = await fetch(url, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		const msg = `[discord] PATCH ${res.status}: ${text.slice(0, 300)}`;
		console.error(msg);
		throw new Error(msg);
	}
}

async function discordPost(url: string, body: MessagePayload): Promise<void> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		const msg = `[discord] POST ${res.status}: ${text.slice(0, 300)}`;
		console.error(msg);
		throw new Error(msg);
	}
}

export async function editFollowup(
	applicationId: string,
	token: string,
	content: string,
	components?: unknown[],
	embeds?: unknown[],
): Promise<void> {
	const body: MessagePayload = {};
	if (embeds?.length) {
		// Omit content entirely when using embeds — sending content:'' causes a 400
		body.embeds = embeds;
	} else {
		body.content = content;
	}
	if (components?.length) body.components = components;
	await discordPatch(`${DISCORD_API}/webhooks/${applicationId}/${token}/messages/@original`, body);
}

export async function sendFollowup(
	applicationId: string,
	token: string,
	content: string,
	components?: unknown[],
	embeds?: unknown[],
): Promise<void> {
	const body: MessagePayload = {};
	if (embeds?.length) {
		body.embeds = embeds;
	} else {
		body.content = content;
	}
	if (components?.length) body.components = components;
	await discordPost(`${DISCORD_API}/webhooks/${applicationId}/${token}`, body);
}
