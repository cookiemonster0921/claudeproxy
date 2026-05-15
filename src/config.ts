import type { Env } from './types';

export interface Settings {
	nvidiaNimApiKey: string | undefined;
	openrouterApiKey: string | undefined;
	deepseekApiKey: string | undefined;
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
}

export function loadSettings(env: Env): Settings {
	return {
		nvidiaNimApiKey: env.NVIDIA_NIM_API_KEY,
		openrouterApiKey: env.OPENROUTER_API_KEY,
		deepseekApiKey: env.DEEPSEEK_API_KEY,
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
	};
}

// Resolve the target provider/model string for a given Claude model name tier
export function resolveModelTarget(settings: Settings, requestedModel: string): string {
	const lower = requestedModel.toLowerCase();
	if (lower.includes('opus')) return settings.modelOpus ?? settings.model;
	if (lower.includes('haiku')) return settings.modelHaiku ?? settings.model;
	return settings.modelSonnet ?? settings.model;
}
