import type { Env } from '../types';
import type { Settings } from '../config';
import { ProxyError } from '../error';
import type { BaseProvider, ProviderConfig } from './base';
import { WorkersAiProvider } from './workers-ai';
import { OpenAIChatProvider } from './openai-compat';
import { CloudflareWorkersAiProvider } from './cloudflare-workers-ai';
import { GeminiProvider } from './gemini/index';

const PROVIDER_BASE_URLS: Record<string, string> = {
	nvidia_nim: 'https://integrate.api.nvidia.com/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	deepseek: 'https://api.deepseek.com/v1',
	lm_studio: 'http://localhost:1234/v1',
	ollama: 'http://localhost:11434/v1',
};

function buildProviderConfig(providerId: string, settings: Settings, _env: Env): ProviderConfig {
	const apiKeyMap: Record<string, string | undefined> = {
		nvidia_nim: settings.nvidiaNimApiKey,
		openrouter: settings.openrouterApiKey,
		deepseek: settings.deepseekApiKey,
		// lm_studio and ollama use no API key
	};

	const baseUrl = PROVIDER_BASE_URLS[providerId];
	if (!baseUrl) {
		throw new ProxyError(400, 'invalid_request_error', `Unsupported provider: "${providerId}"`);
	}

	return {
		apiKey: apiKeyMap[providerId],
		baseUrl,
		readTimeoutMs: settings.readTimeoutMs,
		logRawPayloads: settings.logRawPayloads,
		logErrorTracebacks: settings.logErrorTracebacks,
	};
}

export function createProvider(providerId: string, settings: Settings, env: Env): BaseProvider {
	if (providerId === 'workers_ai') {
		return new WorkersAiProvider(env.AI);
	}

	if (providerId === 'google_ai') {
		return new GeminiProvider(
			settings.googleAiApiKey ?? '',
			settings.geminiBaseUrl,
			settings.geminiTimeoutMs,
		);
	}

	if (providerId === 'cloudflare_workers_ai') {
		if (!settings.cloudflareAccountId) {
			throw new ProxyError(
				400,
				'invalid_request_error',
				'CLOUDFLARE_ACCOUNT_ID is required to use the cloudflare_workers_ai provider',
			);
		}
		return new CloudflareWorkersAiProvider(
			settings.cloudflareApiToken,
			settings.cloudflareAccountId,
			settings.readTimeoutMs,
			settings.logRawPayloads,
			settings.logErrorTracebacks,
		);
	}

	const config = buildProviderConfig(providerId, settings, env);
	return new OpenAIChatProvider(config, providerId);
}
