import type { MessagesRequest } from './types';
import type { Settings } from './config';
import { resolveModelTarget } from './config';
import { ProxyError } from './error';

// Workers AI model map — used as fallback when MODEL env var is unset or "workers_ai"
export const WORKERS_AI_MODEL_MAP: Record<string, string> = {
	'cf-qwen-coder': '@cf/qwen/qwen2.5-coder-32b-instruct',
	'cf-llama': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-sonnet-4-6': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-opus-4-7': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-haiku-4-5': '@cf/qwen/qwen2.5-coder-32b-instruct',
	'claude-3-5-sonnet-20241022': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'claude-3-5-haiku-20241022': '@cf/qwen/qwen2.5-coder-32b-instruct',
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
		const target = resolveModelTarget(this.settings, requestedModel);

		// Explicit Workers AI fallback
		if (target === 'workers_ai') {
			return this.resolveWorkersAi(requestedModel);
		}

		// Legacy @cf/ style Workers AI model ID
		if (target.startsWith('@cf/')) {
			return { originalModel: requestedModel, providerId: 'workers_ai', providerModel: target };
		}

		// "provider_id/model-name" format
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
		const providerModel = WORKERS_AI_MODEL_MAP[requestedModel];
		if (!providerModel) {
			throw new ProxyError(
				400,
				'invalid_request_error',
				`Unknown model: "${requestedModel}". Available: ${Object.keys(WORKERS_AI_MODEL_MAP).join(', ')}`,
			);
		}
		return { originalModel: requestedModel, providerId: 'workers_ai', providerModel };
	}
}
