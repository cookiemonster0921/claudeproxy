// Analytics — request logging to Cloudflare D1.
// Only POST /v1/messages (AI inference calls) are logged.
// Stores metadata + short content snapshots (first 200 chars).
// Raw secrets, full prompts, and full responses are never stored in full.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyticsEvent {
	id: string;
	timestamp: string;
	method: string;
	path: string;
	model: string | undefined;
	provider: string | undefined;
	stream: boolean;
	status_code: number;
	success: boolean;
	duration_ms: number;
	approximate_input_tokens: number;
	approximate_output_tokens: number;
	estimated_cost_usd: number;
	estimated_context_tokens: number;
	estimated_prompt_tokens: number;
	estimated_tool_result_tokens: number;
	billable_input_tokens: number;
	billable_output_tokens: number;
	cached_input_tokens: number;
	failed_request_tokens: number;
	request_kind: string | undefined;
	was_retry: boolean;
	retry_count: number;
	provider_usage_json: string | undefined;
	error_type: string | undefined;
	fallback_used: boolean;
	user_agent: string | undefined;
	client_ip_hash: string | undefined;
	// Content snapshots (first 200 chars each — intentionally stored per user request)
	prompt_snapshot: string | undefined;
	response_snapshot: string | undefined;
	tool_snapshot: string | undefined; // JSON: [{name, args}]
	// Discord source tracking
	source: string | undefined;
	discord_guild_id: string | undefined;
	discord_channel_id: string | undefined;
	discord_command: string | undefined;
}

// Mutable partial — passed through the request lifecycle and populated as routing runs
export interface AnalyticsContext {
	model?: string;
	provider?: string;
	stream?: boolean;
	estimatedContextTokens?: number;
	estimatedPromptTokens?: number;
	estimatedToolResultTokens?: number;
	billableInputTokens?: number;
	billableOutputTokens?: number;
	cachedInputTokens?: number;
	failedRequestTokens?: number;
	estimatedOutputTokens?: number;
	requestKind?: string;
	wasRetry?: boolean;
	retryCount?: number;
	providerUsageJson?: string;
	providerUsageFound?: boolean;
	errorType?: string;
	promptSnapshot?: string;
	responseSnapshot?: string;
	toolSnapshot?: string;
	// Discord source tagging (set by Discord command handlers)
	source?: string;
	discordGuildId?: string;
	discordChannelId?: string;
	discordCommand?: string;
	completion?: Promise<void>;
}

// ---------------------------------------------------------------------------
// Cost estimation (rough approximations — marked as estimates in UI)
// ---------------------------------------------------------------------------

// Cost per 1M tokens in USD. Adjust these to match your actual provider pricing.
const COSTS_PER_1M: Record<string, { input: number; output: number }> = {
	workers_ai: { input: 0.20, output: 0.20 },
	cloudflare_workers_ai: { input: 0.20, output: 0.20 },
	nvidia_nim: { input: 0.27, output: 0.27 },
	openrouter: { input: 0.50, output: 1.50 },
	deepseek: { input: 0.27, output: 1.10 },
	lm_studio: { input: 0, output: 0 },
	ollama: { input: 0, output: 0 },
};

export function estimateCostUsd(
	provider: string | undefined,
	_model: string | undefined,
	inputTokens: number,
	outputTokens: number,
): number {
	if (!provider) return 0;
	const cost = COSTS_PER_1M[provider] ?? { input: 0.50, output: 0.50 };
	return (inputTokens * cost.input + outputTokens * cost.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// IP hashing — HMAC-SHA256 truncated to 16 chars (not reversible)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

export async function hashClientIp(ip: string, secret: string): Promise<string | undefined> {
	if (!ip) return undefined;
	try {
		const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign',
		]);
		const sig = await crypto.subtle.sign('HMAC', key, enc.encode(ip));
		return btoa(String.fromCharCode(...new Uint8Array(sig)))
			.replace(/[+/=]/g, '')
			.slice(0, 16);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// D1 insert — fail-safe: never throws, only warns
// ---------------------------------------------------------------------------

export async function logAnalytics(db: D1Database, event: AnalyticsEvent): Promise<void> {
	try {
		await db
			.prepare(
				`INSERT INTO request_logs
          (id, timestamp, method, path, model, provider, stream, status_code, success,
           duration_ms, approximate_input_tokens, approximate_output_tokens,
           estimated_cost_usd, estimated_context_tokens, estimated_prompt_tokens,
           estimated_tool_result_tokens, billable_input_tokens, billable_output_tokens,
           cached_input_tokens, failed_request_tokens, request_kind, was_retry, retry_count,
           provider_usage_json, error_type, fallback_used, user_agent, client_ip_hash,
           prompt_snapshot, response_snapshot, tool_snapshot,
           source, discord_guild_id, discord_channel_id, discord_command)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.bind(
				event.id,
				event.timestamp,
				event.method,
				event.path,
				event.model ?? null,
				event.provider ?? null,
				event.stream ? 1 : 0,
				event.status_code,
				event.success ? 1 : 0,
				event.duration_ms,
				event.approximate_input_tokens,
				event.approximate_output_tokens,
				event.estimated_cost_usd,
				event.estimated_context_tokens,
				event.estimated_prompt_tokens,
				event.estimated_tool_result_tokens,
				event.billable_input_tokens,
				event.billable_output_tokens,
				event.cached_input_tokens,
				event.failed_request_tokens,
				event.request_kind ?? null,
				event.was_retry ? 1 : 0,
				event.retry_count,
				event.provider_usage_json ?? null,
				event.error_type ?? null,
				event.fallback_used ? 1 : 0,
				event.user_agent ?? null,
				event.client_ip_hash ?? null,
				event.prompt_snapshot ?? null,
				event.response_snapshot ?? null,
				event.tool_snapshot ?? null,
				event.source ?? null,
				event.discord_guild_id ?? null,
				event.discord_channel_id ?? null,
				event.discord_command ?? null,
			)
			.run();
	} catch (err) {
		// Analytics must never break user requests
		console.warn('[analytics] D1 insert failed:', err instanceof Error ? err.message : String(err));
	}
}

// ---------------------------------------------------------------------------
// Analytics query helpers (used by /analytics/* routes)
// ---------------------------------------------------------------------------

export interface ByDimensionRow {
	key: string;
	count: number;
	total_tokens: number;
	total_cost_usd: number;
	billable_tokens: number;
	estimated_context_tokens: number;
}

export interface RecentErrorRow {
	status_code: number;
	path: string;
	error_type: string | null;
	timestamp: string;
}

export interface AnalyticsSummary {
	total_requests: number;
	successful_requests: number;
	failed_requests: number;
	failed_or_rate_limited_requests: number;
	total_estimated_cost_usd: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_billable_tokens: number;
	total_billable_input_tokens: number;
	total_billable_output_tokens: number;
	total_cached_input_tokens: number;
	total_estimated_context_tokens: number;
	total_failed_request_tokens: number;
	avg_duration_ms: number;
	by_model: ByDimensionRow[];
	by_provider: ByDimensionRow[];
	recent_errors: RecentErrorRow[];
}

export async function querySummary(db: D1Database): Promise<AnalyticsSummary> {
	const [agg, byModel, byProvider, recentErrors] = await db.batch([
		db.prepare(`
      SELECT
        COUNT(*)                                                      AS total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END)                 AS successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END)                 AS failed_requests,
        SUM(CASE WHEN success = 0 OR request_kind = 'rate_limited' THEN 1 ELSE 0 END) AS failed_or_rate_limited_requests,
        COALESCE(SUM(estimated_cost_usd), 0)                         AS total_estimated_cost_usd,
        COALESCE(SUM(billable_input_tokens), 0)                      AS total_input_tokens,
        COALESCE(SUM(approximate_output_tokens), 0)                  AS total_output_tokens,
        COALESCE(SUM(billable_input_tokens + billable_output_tokens), 0) AS total_billable_tokens,
        COALESCE(SUM(billable_input_tokens), 0)                      AS total_billable_input_tokens,
        COALESCE(SUM(billable_output_tokens), 0)                     AS total_billable_output_tokens,
        COALESCE(SUM(cached_input_tokens), 0)                        AS total_cached_input_tokens,
        COALESCE(SUM(estimated_context_tokens), 0)                   AS total_estimated_context_tokens,
        COALESCE(SUM(failed_request_tokens), 0)                      AS total_failed_request_tokens,
        COALESCE(ROUND(AVG(duration_ms), 0), 0)                      AS avg_duration_ms
      FROM request_logs`),
		db.prepare(`
      SELECT
        model                                                         AS key,
        COUNT(*)                                                      AS count,
        COALESCE(SUM(billable_input_tokens + billable_output_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost_usd), 0)                         AS total_cost_usd,
        COALESCE(SUM(billable_input_tokens + billable_output_tokens), 0) AS billable_tokens,
        COALESCE(SUM(estimated_context_tokens), 0)                   AS estimated_context_tokens
      FROM request_logs
      WHERE model IS NOT NULL
      GROUP BY model
      ORDER BY count DESC
      LIMIT 20`),
		db.prepare(`
      SELECT
        provider                                                      AS key,
        COUNT(*)                                                      AS count,
        COALESCE(SUM(billable_input_tokens + billable_output_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost_usd), 0)                         AS total_cost_usd,
        COALESCE(SUM(billable_input_tokens + billable_output_tokens), 0) AS billable_tokens,
        COALESCE(SUM(estimated_context_tokens), 0)                   AS estimated_context_tokens
      FROM request_logs
      WHERE provider IS NOT NULL
      GROUP BY provider
      ORDER BY count DESC`),
		db.prepare(`
      SELECT status_code, path, error_type, timestamp
      FROM request_logs
      WHERE success = 0
      ORDER BY timestamp DESC
      LIMIT 5`),
	]);

	const a = (agg.results[0] ?? {}) as Record<string, unknown>;
	return {
		total_requests: Number(a.total_requests ?? 0),
		successful_requests: Number(a.successful_requests ?? 0),
		failed_requests: Number(a.failed_requests ?? 0),
		failed_or_rate_limited_requests: Number(a.failed_or_rate_limited_requests ?? 0),
		total_estimated_cost_usd: Number(a.total_estimated_cost_usd ?? 0),
		total_input_tokens: Number(a.total_input_tokens ?? 0),
		total_output_tokens: Number(a.total_output_tokens ?? 0),
		total_billable_tokens: Number(a.total_billable_tokens ?? 0),
		total_billable_input_tokens: Number(a.total_billable_input_tokens ?? 0),
		total_billable_output_tokens: Number(a.total_billable_output_tokens ?? 0),
		total_cached_input_tokens: Number(a.total_cached_input_tokens ?? 0),
		total_estimated_context_tokens: Number(a.total_estimated_context_tokens ?? 0),
		total_failed_request_tokens: Number(a.total_failed_request_tokens ?? 0),
		avg_duration_ms: Number(a.avg_duration_ms ?? 0),
		by_model: (byModel.results ?? []).map((r) => {
			const row = r as Record<string, unknown>;
			return {
				key: String(row.key ?? ''),
				count: Number(row.count ?? 0),
				total_tokens: Number(row.total_tokens ?? 0),
				total_cost_usd: Number(row.total_cost_usd ?? 0),
				billable_tokens: Number(row.billable_tokens ?? 0),
				estimated_context_tokens: Number(row.estimated_context_tokens ?? 0),
			};
		}),
		by_provider: (byProvider.results ?? []).map((r) => {
			const row = r as Record<string, unknown>;
			return {
				key: String(row.key ?? ''),
				count: Number(row.count ?? 0),
				total_tokens: Number(row.total_tokens ?? 0),
				total_cost_usd: Number(row.total_cost_usd ?? 0),
				billable_tokens: Number(row.billable_tokens ?? 0),
				estimated_context_tokens: Number(row.estimated_context_tokens ?? 0),
			};
		}),
		recent_errors: (recentErrors.results ?? []).map((r) => {
			const row = r as Record<string, unknown>;
			return {
				status_code: Number(row.status_code ?? 0),
				path: String(row.path ?? ''),
				error_type: row.error_type != null ? String(row.error_type) : null,
				timestamp: String(row.timestamp ?? ''),
			};
		}),
	};
}
