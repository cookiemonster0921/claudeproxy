// Shared types, constants, and utilities used across the proxy

// ---------------------------------------------------------------------------
// Env (Cloudflare Workers bindings + env vars)
// ---------------------------------------------------------------------------

export interface Env {
	AI: Ai; // Workers AI binding (kept for backward compat / fallback)
	PROXY_TOKEN?: string;
	// Provider API keys
	NVIDIA_NIM_API_KEY?: string;
	OPENROUTER_API_KEY?: string;
	DEEPSEEK_API_KEY?: string;
	// Model routing: "provider_id/model-name" | "@cf/..." | "workers_ai"
	MODEL?: string;
	MODEL_OPUS?: string;
	MODEL_SONNET?: string;
	MODEL_HAIKU?: string;
	// Rate limiting
	PROVIDER_RATE_LIMIT?: string;
	PROVIDER_RATE_WINDOW?: string;
	PROVIDER_MAX_CONCURRENCY?: string;
	// Timeouts (seconds)
	HTTP_READ_TIMEOUT?: string;
	HTTP_CONNECT_TIMEOUT?: string;
	// Logging
	LOG_RAW_API_PAYLOADS?: string;
	LOG_API_ERROR_TRACEBACKS?: string;
	// Cloudflare Workers AI REST API (external; distinct from env.AI binding)
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	// Analytics (D1)
	DB?: D1Database; // D1 binding — analytics disabled when absent
	ANALYTICS_ENABLED?: string; // default true; set to 'false' to disable
	IP_HASH_SECRET?: string; // HMAC secret for hashing client IPs before storage
	// Google AI Studio / Gemini
	GOOGLE_AI_API_KEY?: string;
	GEMINI_BASE_URL?: string; // optional override; defaults to generativelanguage.googleapis.com/v1beta
	GEMINI_TIMEOUT_MS?: string; // optional timeout in seconds; falls back to HTTP_READ_TIMEOUT
	// Discord integration
	DISCORD_PUBLIC_KEY?: string; // Ed25519 public key — from Discord Developer Portal (not secret)
	DISCORD_APPLICATION_ID?: string; // Discord application/bot ID (not secret)
	DISCORD_BOT_TOKEN?: string; // Bot token — only used in scripts/register-discord-commands.ts
	OPS_BOT_PUBLIC_KEY?: string; // Ed25519 public key for the operations bot
	DISCORD_ALLOWED_GUILD_IDS?: string; // comma-separated guild IDs; empty = all allowed
	DISCORD_ADMIN_ROLE_IDS?: string; // comma-separated role IDs for admin commands; empty = all admins
	DEFAULT_MODEL?: string; // Discord-specific default model (falls back to MODEL)
	DISCORD_STORE_MESSAGES?: string; // 'true' = store full message content in D1; default 'false'
	DISCORD_ENABLE_ADMIN_COMMANDS?: string; // 'false' to disable admin commands; default 'true'
	// Cloud Run container
	CLOUD_RUN_URL?: string; // Cloud Run container URL (e.g. https://claude-agent-xxxx-uc.a.run.app)
	CONTAINER_SECRET?: string; // Auth secret for container's HTTP API
	// Cloudflare Agents SDK bindings
	GOAL_AGENT?: DurableObjectNamespace; // GoalAgent Durable Object namespace
	GOAL_WORKFLOW?: Workflow; // GoalWorkflow binding
	// Ollama provider
	OLLAMA_BASE_URL?: string; // default http://127.0.0.1:11434
	OLLAMA_DEFAULT_MODEL?: string; // default llama3.2
	ENABLE_OLLAMA_PROVIDER?: string; // 'false' to disable; default true
	// Web search (SearXNG)
	SEARXNG_URL?: string; // e.g. http://127.0.0.1:8890 — enables web_search tool for non-Anthropic providers
	// Local session launcher relay (LauncherDO)
	LAUNCHER_DO?: DurableObjectNamespace; // LauncherDO — relays launch commands to local daemons
	// External service keys (used by cloud agent tools)
	VALTOWN_API_KEY?: string; // Val Town API key for cloud agent
	GITHUB_TOKEN?: string; // Optional GitHub token for reading private repos
}

// ---------------------------------------------------------------------------
// Anthropic request types
// ---------------------------------------------------------------------------

export interface TextContentBlock {
	type: 'text';
	text: string;
}

export interface ImageContentBlock {
	type: 'image';
	source: unknown;
}

export interface ToolUseContentBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string | TextContentBlock[];
}

export type ContentBlock =
	| TextContentBlock
	| ImageContentBlock
	| ToolUseContentBlock
	| ToolResultContentBlock;

export interface SystemContentBlock {
	type: 'text';
	text: string;
}

export interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema?: Record<string, unknown>;
}

export interface MessagesRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?: string | SystemContentBlock[];
	stream?: boolean;
	tools?: AnthropicTool[];
	temperature?: number;
}

export interface AnthropicAssistantResponse {
	id: string;
	type: 'message';
	role: 'assistant';
	content: Array<TextContentBlock | ToolUseContentBlock>;
	model: string;
	stop_reason: 'end_turn' | 'tool_use';
	stop_sequence: null;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

// ---------------------------------------------------------------------------
// Workers AI types (used by WorkersAiProvider)
// ---------------------------------------------------------------------------

export interface WorkersAiMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface WorkersAiResponse {
	response?: string;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
	tool_calls?: WorkersAiToolCall[];
}

export interface WorkersAiTool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface WorkersAiToolCall {
	name?: string;
	arguments?: unknown;
}

export interface WorkersAiRequest {
	[key: string]: unknown;
	messages: WorkersAiMessage[];
	max_tokens?: number;
	temperature?: number;
	tools?: WorkersAiTool[];
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

export const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers':
		'Content-Type, Authorization, x-proxy-token, anthropic-version, anthropic-beta, x-api-key, x-claude-code-session-id, x-claude-code-agent-id, x-claude-code-parent-agent-id',
};

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

export function jsonResponse(body: unknown, requestId: string, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'application/json',
			'x-request-id': requestId,
		},
	});
}

export function jsonError(status: number, type: string, message: string, requestId?: string): Response {
	return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
		status,
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'application/json',
			...(requestId ? { 'x-request-id': requestId } : {}),
		},
	});
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export function stringifySystem(system?: string | SystemContentBlock[]): string | undefined {
	if (!system) return undefined;
	if (typeof system === 'string') return system;
	return system.map((b) => b.text).join('\n');
}

export function approxTokens(body: MessagesRequest): number {
	let chars = stringifySystem(body.system)?.length ?? 0;
	for (const msg of body.messages) {
		if (typeof msg.content === 'string') {
			chars += msg.content.length;
		} else {
			for (const block of msg.content) {
				if (block.type === 'text') chars += block.text.length;
			}
		}
	}
	return Math.ceil(chars / 4);
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms),
		),
	]);
}
