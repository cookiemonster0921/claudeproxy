// Cloudflare Workers AI REST API provider
// Calls https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1 (OpenAI-compatible)
// Distinct from the env.AI binding provider (workers_ai) — requires a token + account ID.

import type { MessagesRequest } from '../types';
import type { BaseProvider } from './base';
import { OpenAIChatProvider } from './openai-compat';
import type { RoutedRequest } from '../model-router';

export class CloudflareWorkersAiProvider implements BaseProvider {
	private readonly inner: OpenAIChatProvider;

	constructor(
		apiToken: string | undefined,
		accountId: string,
		readTimeoutMs: number,
		logRawPayloads: boolean,
		logErrorTracebacks: boolean,
	) {
		this.inner = new OpenAIChatProvider(
			{
				apiKey: apiToken,
				baseUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`,
				readTimeoutMs,
				logRawPayloads,
				logErrorTracebacks,
			},
			'cloudflare_workers_ai',
		);
	}

	preflight(body: MessagesRequest): void {
		return this.inner.preflight(body);
	}

	streamResponse(routed: RoutedRequest, inputTokens: number, requestId: string): AsyncIterable<string> {
		return this.inner.streamResponse(routed, inputTokens, requestId);
	}

	async cleanup(): Promise<void> {
		return this.inner.cleanup();
	}
}
