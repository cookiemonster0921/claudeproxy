// GeminiProvider — Google AI Studio / Gemini provider adapter

import type { MessagesRequest } from '../../types';
import type { BaseProvider } from '../base';
import type { RoutedRequest } from '../../model-router';
import { SSEBuilder } from '../../sse';
import { ProxyError } from '../../error';
import { convertToGemini } from './transform';
import { mapGeminiError } from './errors';
import { streamGeminiResponse } from './stream';

export class GeminiProvider implements BaseProvider {
	constructor(
		private readonly apiKey: string,
		private readonly baseUrl: string,
		private readonly timeoutMs: number,
	) {}

	preflight(body: MessagesRequest): void {
		// Eagerly convert to catch unsupported message structures
		convertToGemini(body);
	}

	async *streamResponse(routed: RoutedRequest, inputTokens: number, requestId: string): AsyncGenerator<string> {
		const { body, resolved } = routed;

		if (!this.apiKey) {
			throw new ProxyError(
				401,
				'authentication_error',
				'No GOOGLE_AI_API_KEY configured. Set GOOGLE_AI_API_KEY in your environment.',
			);
		}

		const geminiBody = convertToGemini(body);
		const url = `${this.baseUrl}/models/${resolved.providerModel}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
		const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
		const builder = new SSEBuilder(messageId, body.model, inputTokens);

		let resp: Response;
		try {
			resp = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(geminiBody),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Gemini fetch failed';
			console.error(`[${requestId}] Gemini fetch error:`, msg);
			yield* builder.messageStart();
			yield* builder.emitError(msg);
			return;
		}

		if (!resp.ok) {
			const errBody = await resp.text().catch(() => '');
			const mapped = mapGeminiError(resp.status, errBody);
			throw new ProxyError(mapped.status, mapped.errorType, mapped.message);
		}

		yield* builder.messageStart();
		yield* streamGeminiResponse(resp, builder, requestId);
	}

	async cleanup(): Promise<void> {
		// no-op
	}
}
