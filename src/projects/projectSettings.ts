export interface ProjectSettings {
	projectName: string;
	guildId?: string;
	categoryId?: string;
	categoryName?: string;
	repoUrl?: string;
	defaultModel?: string;
	provider?: string;
	systemPrompt?: string;
	budgetUsd: number;
}

function rowToProject(r: Record<string, unknown>): ProjectSettings {
	return {
		projectName: String(r.project_name),
		guildId: r.guild_id != null ? String(r.guild_id) : undefined,
		categoryId: r.category_id != null ? String(r.category_id) : undefined,
		categoryName: r.category_name != null ? String(r.category_name) : undefined,
		repoUrl: r.repo_url != null ? String(r.repo_url) : undefined,
		defaultModel: r.default_model != null ? String(r.default_model) : undefined,
		provider: r.provider != null ? String(r.provider) : undefined,
		systemPrompt: r.system_prompt != null ? String(r.system_prompt) : undefined,
		budgetUsd: Number(r.budget_usd ?? 0),
	};
}

export async function getProject(db: D1Database, projectName: string): Promise<ProjectSettings | null> {
	const row = await db.prepare('SELECT * FROM discord_projects WHERE project_name = ?').bind(projectName).first();
	if (!row) return null;
	return rowToProject(row as Record<string, unknown>);
}

export async function getProjectByCategory(
	db: D1Database,
	guildId: string,
	categoryId: string,
): Promise<ProjectSettings | null> {
	const row = await db
		.prepare('SELECT * FROM discord_projects WHERE guild_id = ? AND category_id = ? LIMIT 1')
		.bind(guildId, categoryId)
		.first();
	if (!row) return null;
	return rowToProject(row as Record<string, unknown>);
}

export async function upsertProject(
	db: D1Database,
	settings: Partial<ProjectSettings> & { projectName: string },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO discord_projects
         (project_name, guild_id, category_id, category_name, repo_url, default_model,
          provider, system_prompt, budget_usd, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(project_name) DO UPDATE SET
         guild_id      = COALESCE(excluded.guild_id, guild_id),
         category_id   = COALESCE(excluded.category_id, category_id),
         category_name = COALESCE(excluded.category_name, category_name),
         repo_url      = COALESCE(excluded.repo_url, repo_url),
         default_model = COALESCE(excluded.default_model, default_model),
         provider      = COALESCE(excluded.provider, provider),
         system_prompt = COALESCE(excluded.system_prompt, system_prompt),
         budget_usd    = COALESCE(excluded.budget_usd, budget_usd),
         updated_at    = datetime('now')`,
		)
		.bind(
			settings.projectName,
			settings.guildId ?? null,
			settings.categoryId ?? null,
			settings.categoryName ?? null,
			settings.repoUrl ?? null,
			settings.defaultModel ?? null,
			settings.provider ?? null,
			settings.systemPrompt ?? null,
			settings.budgetUsd ?? null,
		)
		.run();
}

export async function listProjects(db: D1Database, guildId: string): Promise<ProjectSettings[]> {
	const result = await db
		.prepare('SELECT * FROM discord_projects WHERE guild_id = ? ORDER BY project_name')
		.bind(guildId)
		.all();
	return (result.results ?? []).map((r) => rowToProject(r as Record<string, unknown>));
}
