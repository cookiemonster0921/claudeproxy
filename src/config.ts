import type { Env } from './types';

export interface Settings {
	nvidiaNimApiKey: string | undefined;
	openrouterApiKey: string | undefined;
	deepseekApiKey: string | undefined;
	googleAiApiKey: string | undefined;
	geminiBaseUrl: string;
	geminiTimeoutMs: number;
	model: string; // "workers_ai" when MODEL env var is unset
	modelOpus: string | undefined;
	modelSonnet: string | undefined;
	modelHaiku: string | undefined;
	providerRateLimit: number;
	providerRateWindowMs: number;
	providerMaxConcurrency: number;
	readTimeoutMs: number;
	connectTimeoutMs: number;
	logRawPayloads: boolean;
	logErrorTracebacks: boolean;
	cloudflareApiToken: string | undefined;
	cloudflareAccountId: string;
}

export function loadSettings(env: Env): Settings {
	return {
		nvidiaNimApiKey: env.NVIDIA_NIM_API_KEY,
		openrouterApiKey: env.OPENROUTER_API_KEY,
		deepseekApiKey: env.DEEPSEEK_API_KEY,
		googleAiApiKey: env.GOOGLE_AI_API_KEY,
		geminiBaseUrl: env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
		geminiTimeoutMs: parseInt(env.GEMINI_TIMEOUT_MS ?? env.HTTP_READ_TIMEOUT ?? '300', 10) * 1000,
		model: env.MODEL ?? 'workers_ai',
		modelOpus: env.MODEL_OPUS,
		modelSonnet: env.MODEL_SONNET,
		modelHaiku: env.MODEL_HAIKU,
		providerRateLimit: parseInt(env.PROVIDER_RATE_LIMIT ?? '40', 10),
		providerRateWindowMs: parseInt(env.PROVIDER_RATE_WINDOW ?? '60', 10) * 1000,
		providerMaxConcurrency: parseInt(env.PROVIDER_MAX_CONCURRENCY ?? '5', 10),
		readTimeoutMs: parseInt(env.HTTP_READ_TIMEOUT ?? '300', 10) * 1000,
		connectTimeoutMs: parseInt(env.HTTP_CONNECT_TIMEOUT ?? '10', 10) * 1000,
		logRawPayloads: env.LOG_RAW_API_PAYLOADS === 'true',
		logErrorTracebacks: env.LOG_API_ERROR_TRACEBACKS === 'true',
		cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
		cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
	};
}

// Resolve the target provider/model string for a given Claude model name tier.
// If the model is already a fully-qualified provider string (e.g. "openrouter/anthropic/claude-sonnet-4-5"
// or "@cf/meta/llama-3.3-70b-instruct-fp8-fast"), pass it through as-is.
export function resolveModelTarget(settings: Settings, requestedModel: string): string {
	// Already provider-qualified — don't remap through tier settings
	if (requestedModel.includes('/')) return requestedModel;

	const lower = requestedModel.toLowerCase();
	if (lower.includes('opus')) return settings.modelOpus ?? settings.model;
	if (lower.includes('haiku')) return settings.modelHaiku ?? settings.model;
	return settings.modelSonnet ?? settings.model;
}
