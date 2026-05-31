export interface ConversationMessage {
	role: 'user' | 'assistant';
	content: string;
	discordMessageId?: string;
	timestamp: string;
}

async function sha256Hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function addMessage(
	db: D1Database,
	channelId: string,
	msg: ConversationMessage,
	storeMessages: boolean,
): Promise<void> {
	const contentToStore = storeMessages ? msg.content : null;
	const hash = storeMessages ? null : await sha256Hex(msg.content);
	await db
		.prepare(
			`INSERT INTO discord_messages (channel_id, role, content, discord_message_id, content_hash)
       VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(channelId, msg.role, contentToStore, msg.discordMessageId ?? null, hash)
		.run();
}

export async function getHistory(
	db: D1Database,
	channelId: string,
	limit = 20,
): Promise<ConversationMessage[]> {
	const result = await db
		.prepare(
			`SELECT role, content, discord_message_id, timestamp
       FROM discord_messages
       WHERE channel_id = ? AND content IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
		)
		.bind(channelId, limit)
		.all();
	return (result.results ?? [])
		.reverse()
		.map((r) => {
			const row = r as Record<string, unknown>;
			return {
				role: String(row.role) as 'user' | 'assistant',
				content: String(row.content),
				discordMessageId: row.discord_message_id != null ? String(row.discord_message_id) : undefined,
				timestamp: String(row.timestamp),
			};
		});
}

export async function clearHistory(db: D1Database, channelId: string): Promise<void> {
	await db.prepare(`DELETE FROM discord_messages WHERE channel_id = ?`).bind(channelId).run();
}

export async function countMessages(db: D1Database, channelId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS cnt FROM discord_messages WHERE channel_id = ?`)
		.bind(channelId)
		.first();
	return Number((row as Record<string, unknown> | null)?.cnt ?? 0);
}

export async function getLastUserMessage(db: D1Database, channelId: string): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT content FROM discord_messages WHERE channel_id = ? AND role = 'user' AND content IS NOT NULL ORDER BY id DESC LIMIT 1`,
		)
		.bind(channelId)
		.first();
	if (!row) return null;
	return String((row as Record<string, unknown>).content);
}

export function exportHistory(history: ConversationMessage[], format: 'txt' | 'md'): string {
	if (format === 'md') {
		return history
			.map((m) => {
				const label = m.role === 'user' ? '**User**' : '**Claude**';
				return `${label} *(${m.timestamp})*\n\n${m.content}`;
			})
			.join('\n\n---\n\n');
	}
	return history
		.map((m) => {
			const label = m.role === 'user' ? 'User' : 'Claude';
			return `[${label}] ${m.timestamp}\n${m.content}`;
		})
		.join('\n\n');
}
