import type { MessagesRequest } from './types';
import type { Settings } from './config';
import { resolveModelTarget } from './config';
import { ProxyError } from './error';

// Gemini model short-name aliases — lets clients send "gemini-2.5-flash" without the
// "google_ai/" prefix.  Checked in ModelRouter.resolve() before tier routing.
export const GEMINI_MODEL_ALIASES: Record<string, string> = {
	'gemini-3.5-flash':      'google_ai/gemini-3.5-flash',
	'gemini-3.1-flash-lite': 'google_ai/gemini-3.1-flash-lite',
	'gemini-3-flash-preview':'google_ai/gemini-3-flash-preview',
	'gemini-2.5-pro':        'google_ai/gemini-2.5-pro',
	'gemini-2.5-flash':      'google_ai/gemini-2.5-flash',
	'gemini-2.5-flash-lite': 'google_ai/gemini-2.5-flash-lite',
	'gemini-2.0-flash':      'google_ai/gemini-2.0-flash',
};

// ---------------------------------------------------------------------------
// Provider catalog — the canonical list of real models the proxy can reach.
//
// Each entry has:
//   id           — provider-qualified model ID used in API requests
//                  (e.g. "workers_ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast")
//   display_name — human-readable label shown in the cproxy picker
//   owned_by     — provider key used for grouping ("workers_ai", "google_ai", …)
//   requires_key — env-var that must be set; absent = always available
//
// Mirrors the model arrays in claude-proxy.sh so both pickers stay in sync.
// ---------------------------------------------------------------------------
export interface CatalogModel {
	id: string;
	display_name: string;
	owned_by: string;
	requires_key?: string;
}

export const PROVIDER_CATALOG: CatalogModel[] = [
	// ── Workers AI (env.AI binding — no external key needed) ────────────────
	// IDs are the short names defined in WORKERS_AI_MODEL_MAP above.
	// cproxy passes these verbatim as --model; ModelRouter.resolveWorkersAi() maps them
	// to the real @cf/ path before forwarding to the binding.
	{ id: 'cf-llama',      display_name: 'Llama 3.3 70B (fp8-fast)',  owned_by: 'workers_ai' },
	{ id: 'cf-llama-8b',   display_name: 'Llama 3.1 8B Instruct',     owned_by: 'workers_ai' },
	{ id: 'cf-qwen-coder', display_name: 'Qwen 2.5 Coder 32B',        owned_by: 'workers_ai' },
	{ id: 'cf-kimi-k2',    display_name: 'Kimi K2 (Moonshot AI)',     owned_by: 'workers_ai' },

	// ── Google AI Studio ─────────────────────────────────────────────────────
	// IDs are the short Gemini names present in GEMINI_MODEL_ALIASES above.
	// ModelRouter.resolve() checks GEMINI_MODEL_ALIASES FIRST, so passing
	// "gemini-2.5-flash" as --model routes correctly without a provider prefix.
	{ id: 'gemini-3.5-flash',      display_name: 'Gemini 3.5 Flash (recommended)', owned_by: 'google_ai', requires_key: 'GOOGLE_AI_API_KEY' },
	{ id: 'gemini-3.1-flash-lite', display_name: 'Gemini 3.1 Flash Lite',          owned_by: 'google_ai', requires_key: 'GOOGLE_AI_API_KEY' },
	{ id: 'gemini-3-flash-preview',display_name: 'Gemini 3 Flash Preview',          owned_by: 'google_ai', requires_key: 'GOOGLE_AI_API_KEY' },
	{ id: 'gemini-2.5-pro',        display_name: 'Gemini 2.5 Pro',                 owned_by: 'google_ai', requires_key: 'GOOGLE_AI_API_KEY' },
	{ id: 'gemini-2.5-flash',      display_name: 'Gemini 2.5 Flash',               owned_by: 'google_ai', requires_key: 'GOOGLE_AI_API_KEY' },
	{ id: 'gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash Lite',          owned_by: 'google_ai', requires_key: 'GOOGLE_AI_API_KEY' },
	{ id: 'gemini-2.0-flash',      display_name: 'Gemini 2.0 Flash',               owned_by: 'google_ai', requires_key: 'GOOGLE_AI_API_KEY' },

	// ── OpenRouter ───────────────────────────────────────────────────────────
	// Full provider-qualified IDs — the "openrouter/" prefix triggers provider
	// detection in ModelRouter.resolve() via the slash-split path.
	{ id: 'openrouter/meta-llama/llama-3.3-70b-instruct',       display_name: 'Llama 3.3 70B Instruct (free)', owned_by: 'openrouter', requires_key: 'OPENROUTER_API_KEY' },
	{ id: 'openrouter/deepseek/deepseek-chat-v3-0324',          display_name: 'DeepSeek Chat V3',              owned_by: 'openrouter', requires_key: 'OPENROUTER_API_KEY' },
	{ id: 'openrouter/deepseek/deepseek-r1',                    display_name: 'DeepSeek R1 (reasoning)',       owned_by: 'openrouter', requires_key: 'OPENROUTER_API_KEY' },
	{ id: 'openrouter/qwen/qwen3-235b-a22b',                    display_name: 'Qwen3 235B A22B',               owned_by: 'openrouter', requires_key: 'OPENROUTER_API_KEY' },
	{ id: 'openrouter/google/gemini-2.0-flash-001',             display_name: 'Gemini 2.0 Flash',             owned_by: 'openrouter', requires_key: 'OPENROUTER_API_KEY' },
	{ id: 'openrouter/mistralai/mistral-small-3.1-24b-instruct',display_name: 'Mistral Small 3.1',            owned_by: 'openrouter', requires_key: 'OPENROUTER_API_KEY' },

	// ── NVIDIA NIM ───────────────────────────────────────────────────────────
	// Full provider-qualified IDs — same slash-split routing as OpenRouter.
	{ id: 'nvidia_nim/meta/llama-3.3-70b-instruct',      display_name: 'Llama 3.3 70B Instruct (fast)', owned_by: 'nvidia_nim', requires_key: 'NVIDIA_NIM_API_KEY' },
	{ id: 'nvidia_nim/meta/llama-3.1-405b-instruct',     display_name: 'Llama 3.1 405B Instruct',       owned_by: 'nvidia_nim', requires_key: 'NVIDIA_NIM_API_KEY' },
	{ id: 'nvidia_nim/deepseek/deepseek-r1',             display_name: 'DeepSeek R1 (reasoning)',        owned_by: 'nvidia_nim', requires_key: 'NVIDIA_NIM_API_KEY' },
	{ id: 'nvidia_nim/qwen/qwen2.5-coder-32b-instruct',  display_name: 'Qwen 2.5 Coder 32B',            owned_by: 'nvidia_nim', requires_key: 'NVIDIA_NIM_API_KEY' },
	{ id: 'nvidia_nim/nv-mistralai/mistral-nemo-12b-instruct', display_name: 'Mistral NeMo 12B',         owned_by: 'nvidia_nim', requires_key: 'NVIDIA_NIM_API_KEY' },
];

// Workers AI model map — maps short IDs and Claude model names → CF Workers AI model IDs.
// Short IDs (cf-*) are what /v1/models returns and what the cproxy picker passes as --model.
// Claude model names are kept for backward compat (default tier routing when MODEL=workers_ai).
export const WORKERS_AI_MODEL_MAP: Record<string, string> = {
	// Short IDs shown in the model picker (clean, no provider path)
	'cf-llama':       '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'cf-llama-8b':    '@cf/meta/llama-3.1-8b-instruct',
	'cf-qwen-coder':  '@cf/qwen/qwen2.5-coder-32b-instruct',
	'cf-kimi-k2':     '@cf/moonshotai/kimi-k2-instruct',

	// Claude model name → tier fallback (used when MODEL env var = "workers_ai")
	'claude-opus-4-8':          '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-opus-4-7':          '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-sonnet-4-6':        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-3-5-sonnet-20241022': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-haiku-4-5':         '@cf/qwen/qwen2.5-coder-32b-instruct',
	'claude-3-5-haiku-20241022':  '@cf/qwen/qwen2.5-coder-32b-instruct',
};

export interface ResolvedModel {
	originalModel: string; // what the client sent (e.g. "claude-sonnet-4-6")
	providerId: string; // "workers_ai" | "nvidia_nim" | "openrouter" | "deepseek" | ...
	providerModel: string; // model ID the provider understands
}

export interface RoutedRequest {
	body: MessagesRequest;
	resolved: ResolvedModel;
}

export class ModelRouter {
	constructor(private readonly settings: Settings) {}

	resolve(requestedModel: string): ResolvedModel {
		// ── 1. Gemini short-name aliases (checked before tier routing) ──────────
		// Allows `--model gemini-2.5-flash` to reach Google AI without the user
		// needing to type the full "google_ai/gemini-2.5-flash" provider path.
		if (requestedModel in GEMINI_MODEL_ALIASES) {
			const qualified = GEMINI_MODEL_ALIASES[requestedModel]; // "google_ai/gemini-2.5-flash"
			const slash = qualified.indexOf('/');
			return {
				originalModel: requestedModel,
				providerId: qualified.slice(0, slash),   // "google_ai"
				providerModel: qualified.slice(slash + 1), // "gemini-2.5-flash"
			};
		}

		// ── 2. Tier routing via MODEL / MODEL_OPUS / MODEL_SONNET / MODEL_HAIKU ─
		const target = resolveModelTarget(this.settings, requestedModel);

		// Explicit Workers AI fallback
		if (target === 'workers_ai') {
			return this.resolveWorkersAi(requestedModel);
		}

		// Legacy @cf/ style Workers AI model ID
		if (target.startsWith('@cf/')) {
			return { originalModel: requestedModel, providerId: 'workers_ai', providerModel: target };
		}

		// "provider_id/model-name" format (e.g. "openrouter/meta-llama/llama-3.3-70b-instruct")
		const slash = target.indexOf('/');
		if (slash === -1) {
			throw new ProxyError(
				400,
				'invalid_request_error',
				`Invalid MODEL value: "${target}". Use "provider_id/model-name" (e.g. "nvidia_nim/meta/llama-3.3-70b-instruct") or leave unset to use Workers AI.`,
			);
		}

		const providerId = target.slice(0, slash);
		const providerModel = target.slice(slash + 1);
		return { originalModel: requestedModel, providerId, providerModel };
	}

	resolveRequest(body: MessagesRequest): RoutedRequest {
		return { body, resolved: this.resolve(body.model) };
	}

	private resolveWorkersAi(requestedModel: string): ResolvedModel {
		// Direct map hit
		const providerModel = WORKERS_AI_MODEL_MAP[requestedModel];
		if (providerModel) {
			return { originalModel: requestedModel, providerId: 'workers_ai', providerModel };
		}

		// Tier-based fallback for unrecognised claude-* names (e.g. claude-opus-4-9 when it ships).
		// Rather than crashing, route by tier so the proxy stays working across Claude releases.
		const lower = requestedModel.toLowerCase();
		if (lower.startsWith('claude')) {
			let tierKey: string;
			if (lower.includes('opus'))  tierKey = 'claude-opus-4-8';
			else if (lower.includes('haiku')) tierKey = 'claude-haiku-4-5';
			else tierKey = 'claude-sonnet-4-6'; // sonnet is the default tier

			const fallback = WORKERS_AI_MODEL_MAP[tierKey];
			if (fallback) {
				console.warn(
					JSON.stringify({ event: 'model_fallback', requestedModel, routedVia: tierKey }),
				);
				return { originalModel: requestedModel, providerId: 'workers_ai', providerModel: fallback };
			}
		}

		throw new ProxyError(
			400,
			'invalid_request_error',
			`Unknown model: "${requestedModel}". Available: ${Object.keys(WORKERS_AI_MODEL_MAP).join(', ')}`,
		);
	}
}
