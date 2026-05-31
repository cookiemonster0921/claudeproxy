import type { EffortLevel } from './settingsResolver';

export interface Session {
	channelId: string;
	guildId?: string;
	categoryId?: string;
	threadId?: string;
	sessionId?: string;
	projectName?: string;
	modelOverride?: string;
	effortLevel: EffortLevel;
	status: 'active' | 'stopped';
	goal?: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
}

function rowToSession(r: Record<string, unknown>): Session {
	return {
		channelId: String(r.channel_id),
		guildId: r.guild_id != null ? String(r.guild_id) : undefined,
		categoryId: r.category_id != null ? String(r.category_id) : undefined,
		threadId: r.thread_id != null ? String(r.thread_id) : undefined,
		sessionId: r.session_id != null ? String(r.session_id) : undefined,
		projectName: r.project_name != null ? String(r.project_name) : undefined,
		modelOverride: r.model_override != null ? String(r.model_override) : undefined,
		effortLevel: (r.effort_level as EffortLevel | null) ?? 'auto',
		status: (r.status as 'active' | 'stopped' | null) ?? 'active',
		goal: r.goal != null ? String(r.goal) : undefined,
		messageCount: Number(r.message_count ?? 0),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	};
}

export async function getSession(db: D1Database, channelId: string): Promise<Session | null> {
	const row = await db.prepare('SELECT * FROM discord_sessions WHERE channel_id = ?').bind(channelId).first();
	if (!row) return null;
	return rowToSession(row as Record<string, unknown>);
}

export async function upsertSession(
	db: D1Database,
	partial: Partial<Session> & { channelId: string },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO discord_sessions
         (channel_id, guild_id, category_id, thread_id, session_id, project_name,
          model_override, effort_level, status, goal, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(channel_id) DO UPDATE SET
         guild_id      = COALESCE(excluded.guild_id, guild_id),
         category_id   = COALESCE(excluded.category_id, category_id),
         thread_id     = COALESCE(excluded.thread_id, thread_id),
         session_id    = COALESCE(excluded.session_id, session_id),
         project_name  = CASE WHEN excluded.project_name IS NOT NULL THEN excluded.project_name ELSE project_name END,
         model_override= CASE WHEN excluded.model_override IS NOT NULL THEN excluded.model_override ELSE model_override END,
         effort_level  = COALESCE(excluded.effort_level, effort_level),
         status        = COALESCE(excluded.status, status),
         goal          = CASE WHEN excluded.goal IS NOT NULL THEN excluded.goal ELSE goal END,
         updated_at    = datetime('now')`,
		)
		.bind(
			partial.channelId,
			partial.guildId ?? null,
			partial.categoryId ?? null,
			partial.threadId ?? null,
			partial.sessionId ?? null,
			partial.projectName ?? null,
			partial.modelOverride ?? null,
			partial.effortLevel ?? null,
			partial.status ?? null,
			partial.goal ?? null,
		)
		.run();
}

export async function incrementMessageCount(db: D1Database, channelId: string): Promise<void> {
	await db
		.prepare(
			`UPDATE discord_sessions SET message_count = message_count + 1, updated_at = datetime('now') WHERE channel_id = ?`,
		)
		.bind(channelId)
		.run();
}

export async function setGoal(db: D1Database, channelId: string, goal: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO discord_sessions (channel_id, goal, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(channel_id) DO UPDATE SET goal = excluded.goal, updated_at = datetime('now')`,
		)
		.bind(channelId, goal)
		.run();
}

export async function setStatus(db: D1Database, channelId: string, status: 'active' | 'stopped'): Promise<void> {
	await db
		.prepare(
			`UPDATE discord_sessions SET status = ?, updated_at = datetime('now') WHERE channel_id = ?`,
		)
		.bind(status, channelId)
		.run();
}

export async function clearSessionOverrides(db: D1Database, channelId: string): Promise<void> {
	await db
		.prepare(
			`UPDATE discord_sessions SET model_override = NULL, effort_level = 'auto', status = 'active',
         goal = NULL, message_count = 0, updated_at = datetime('now') WHERE channel_id = ?`,
		)
		.bind(channelId)
		.run();
}
