import type { MessagesRequest } from '../types';
import { SSEBuilder } from '../sse';
import { AnthropicToOpenAIConverter } from '../converter';
import { mapHttpError, ProxyError } from '../error';
import type { BaseProvider, ProviderConfig } from './base';
import type { RoutedRequest } from '../model-router';

interface OpenAIStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
}

interface BufferedToolCall {
	id: string;
	name: string;
	args: string;
}

// Headers added per-provider for routing attribution
const EXTRA_HEADERS: Record<string, Record<string, string>> = {
	openrouter: {
		'HTTP-Referer': 'https://github.com/anthropics/claude-code',
		'X-Title': 'Claude Code Proxy',
	},
};

export class OpenAIChatProvider implements BaseProvider {
	constructor(
		private readonly config: ProviderConfig,
		private readonly providerId: string,
	) {}

	preflight(body: MessagesRequest): void {
		// Eagerly convert to catch unsupported message structures
		AnthropicToOpenAIConverter.convert(body, { model: 'preflight' });
	}

	async *streamResponse(routed: RoutedRequest, inputTokens: number, requestId: string): AsyncGenerator<string> {
		const { body, resolved } = routed;

		if (!this.config.apiKey) {
			throw new ProxyError(
				401,
				'authentication_error',
				`No API key configured for provider "${this.providerId}". Set ${this.providerId.toUpperCase()}_API_KEY.`,
			);
		}

		const openAiBody = AnthropicToOpenAIConverter.convert(body, { model: resolved.providerModel });
		const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
		const builder = new SSEBuilder(messageId, body.model, inputTokens);

		const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				'Content-Type': 'application/json',
				...(EXTRA_HEADERS[this.providerId] ?? {}),
			},
			body: JSON.stringify({ ...openAiBody, stream: true, stream_options: { include_usage: true } }),
			signal: AbortSignal.timeout(this.config.readTimeoutMs),
		});

		if (!resp.ok) {
			const errBody = await resp.text().catch(() => '');
			const mapped = mapHttpError(resp.status, errBody);
			throw new ProxyError(mapped.status, mapped.errorType, mapped.message);
		}

		yield* builder.messageStart();

		const reader = resp.body!.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		let outputTokens = 0;
		let stopReason: 'end_turn' | 'tool_use' = 'end_turn';
		let textBlockOpen = false;
		let lastChunk: OpenAIStreamChunk | undefined;

		// Buffer tool calls — emit them all at the end (after text) to avoid index conflicts
		const toolCallsBuffer = new Map<number, BufferedToolCall>();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6).trim();
					if (payload === '[DONE]') continue;

					let parsed: OpenAIStreamChunk;
					try {
						parsed = JSON.parse(payload) as OpenAIStreamChunk;
					} catch {
						continue;
					}
					lastChunk = parsed;

					const choice = parsed.choices?.[0];
					if (!choice) continue;

					if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';

					const delta = choice.delta;
					if (!delta) continue;

					// Stream text deltas immediately
					if (delta.content) {
						if (!textBlockOpen) {
							yield* builder.openTextBlock();
							textBlockOpen = true;
						}
						outputTokens += Math.ceil(delta.content.length / 4);
						yield* builder.textDelta(delta.content);
					}

					// Accumulate tool calls into buffer
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							if (!toolCallsBuffer.has(idx)) {
								toolCallsBuffer.set(idx, {
									id: tc.id ?? `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
									name: tc.function?.name ?? '',
									args: '',
								});
							}
							const call = toolCallsBuffer.get(idx)!;
							if (tc.id && !call.id) call.id = tc.id;
							if (tc.function?.name && !call.name) call.name = tc.function.name;
							if (tc.function?.arguments) call.args += tc.function.arguments;
						}
					}
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Stream read error';
			console.error(`[${requestId}] OpenAI stream error:`, msg);
			if (textBlockOpen) yield* builder.closeBlock();
			yield* builder.emitError(msg);
			return;
		}

		// Close text block
		if (textBlockOpen) yield* builder.closeBlock();

		// Emit buffered tool calls in order
		for (const [, call] of [...toolCallsBuffer.entries()].sort(([a], [b]) => a - b)) {
			yield* builder.openToolBlock(call.id, call.name);
			yield* builder.toolInputDelta(call.args);
			yield* builder.closeBlock();
		}

		// Use actual token count from provider if available
		if (lastChunk?.usage?.completion_tokens) {
			outputTokens = lastChunk.usage.completion_tokens;
		}

		yield* builder.messageStop(
			stopReason,
			outputTokens,
			lastChunk?.usage
				? {
						...(lastChunk.usage.prompt_tokens !== undefined ? { input_tokens: lastChunk.usage.prompt_tokens } : {}),
						output_tokens: outputTokens,
						...(lastChunk.usage.prompt_tokens_details?.cached_tokens !== undefined
							? { cache_read_input_tokens: lastChunk.usage.prompt_tokens_details.cached_tokens }
							: {}),
					}
				: undefined,
		);
	}

	async cleanup(): Promise<void> {
		// no-op
	}
}
