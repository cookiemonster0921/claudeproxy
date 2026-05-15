import type { Env, MessagesRequest, AnthropicAssistantResponse, TextContentBlock, ToolUseContentBlock } from './types';
import { CORS_HEADERS, approxTokens, jsonResponse } from './types';
import type { Settings } from './config';
import { ProxyError } from './error';
import { ModelRouter } from './model-router';
import { GlobalRateLimiter } from './rate-limit';
import { createProvider } from './providers/registry';

// Parse buffered SSE text into an AnthropicAssistantResponse (for non-streaming path)
function parseAnthropicResponseFromSSE(
	sseText: string,
	fallbackModel: string,
	fallbackInputTokens: number,
): AnthropicAssistantResponse {
	let messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
	let parsedModel = fallbackModel;
	let stopReason: 'end_turn' | 'tool_use' = 'end_turn';
	let outputTokens = 0;
	let parsedInputTokens = fallbackInputTokens;

	// Per-block state keyed by upstream index
	const blocks = new Map<
		number,
		{ type: string; text?: string; id?: string; name?: string; argsBuf?: string }
	>();

	const lines = sseText.split('\n');
	let pendingData = '';

	for (const line of lines) {
		if (line.startsWith('data: ')) {
			pendingData = line.slice(6);
		} else if (line === '' && pendingData) {
			try {
				const event = JSON.parse(pendingData) as Record<string, unknown>;
				const type = event.type as string;

				if (type === 'message_start') {
					const msg = event.message as Record<string, unknown> | undefined;
					if (msg) {
						messageId = (msg.id as string | undefined) ?? messageId;
						parsedModel = (msg.model as string | undefined) ?? parsedModel;
						const usage = msg.usage as Record<string, number> | undefined;
						if (usage?.input_tokens) parsedInputTokens = usage.input_tokens;
					}
				} else if (type === 'content_block_start') {
					const idx = event.index as number;
					const cb = event.content_block as Record<string, unknown> | undefined;
					if (cb?.type === 'text') {
						blocks.set(idx, { type: 'text', text: '' });
					} else if (cb?.type === 'tool_use') {
						blocks.set(idx, {
							type: 'tool_use',
							id: cb.id as string | undefined,
							name: cb.name as string | undefined,
							argsBuf: '',
						});
					}
				} else if (type === 'content_block_delta') {
					const idx = event.index as number;
					const block = blocks.get(idx);
					const delta = event.delta as Record<string, unknown> | undefined;
					if (block && delta) {
						if (delta.type === 'text_delta') {
							block.text = (block.text ?? '') + (delta.text as string);
						} else if (delta.type === 'input_json_delta') {
							block.argsBuf = (block.argsBuf ?? '') + (delta.partial_json as string);
						}
					}
				} else if (type === 'message_delta') {
					const delta = event.delta as Record<string, unknown> | undefined;
					if (delta?.stop_reason === 'tool_use') stopReason = 'tool_use';
					const usage = event.usage as Record<string, number> | undefined;
					if (usage?.output_tokens) outputTokens = usage.output_tokens;
				}
			} catch {
				// skip malformed SSE event
			}
			pendingData = '';
		}
	}

	// Reconstruct content array in index order
	const content: Array<TextContentBlock | ToolUseContentBlock> = [];
	for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
		if (block.type === 'text' && block.text !== undefined) {
			content.push({ type: 'text', text: block.text });
		} else if (block.type === 'tool_use' && block.id && block.name) {
			let input: Record<string, unknown> = {};
			if (block.argsBuf) {
				try {
					input = JSON.parse(block.argsBuf) as Record<string, unknown>;
				} catch {
					// keep empty input if JSON is malformed
				}
			}
			content.push({ type: 'tool_use', id: block.id, name: block.name, input });
		}
	}
	if (content.length === 0) content.push({ type: 'text', text: '' });

	return {
		id: messageId,
		type: 'message',
		role: 'assistant',
		content,
		model: parsedModel,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: { input_tokens: parsedInputTokens, output_tokens: outputTokens },
	};
}

export class ProxyService {
	private readonly router: ModelRouter;
	private readonly rateLimiter: GlobalRateLimiter;

	constructor(
		private readonly settings: Settings,
		private readonly env: Env,
	) {
		this.router = new ModelRouter(settings);
		this.rateLimiter = new GlobalRateLimiter(
			settings.providerRateLimit,
			settings.providerRateWindowMs,
			settings.providerMaxConcurrency,
		);
	}

	async handleMessages(body: MessagesRequest, requestId: string): Promise<Response> {
		if (!body.messages?.length) {
			throw new ProxyError(400, 'invalid_request_error', 'messages array must not be empty');
		}

		const routed = this.router.resolveRequest(body);
		const provider = createProvider(routed.resolved.providerId, this.settings, this.env);
		provider.preflight(body);

		const inputTokens = approxTokens(body);
		const stream = body.stream ?? false;

		console.log(
			JSON.stringify({
				event: 'messages',
				requestId,
				model: body.model,
				providerId: routed.resolved.providerId,
				providerModel: routed.resolved.providerModel,
				stream,
				inputTokens,
				toolCount: body.tools?.length ?? 0,
				ts: new Date().toISOString(),
			}),
		);

		if (!stream) {
			// Non-streaming: buffer all SSE, parse into JSON response
			const release = await this.rateLimiter.acquire();
			try {
				const chunks: string[] = [];
				for await (const chunk of provider.streamResponse(routed, inputTokens, requestId)) {
					chunks.push(chunk);
				}
				const message = parseAnthropicResponseFromSSE(chunks.join(''), body.model, inputTokens);
				return jsonResponse(message, requestId);
			} finally {
				release();
				await provider.cleanup();
			}
		}

		// Streaming: pipe provider generator through TransformStream to client
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();

		(async () => {
			const release = await this.rateLimiter.acquire();
			try {
				for await (const chunk of provider.streamResponse(routed, inputTokens, requestId)) {
					await writer.write(encoder.encode(chunk));
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Provider error';
				console.error(`[${requestId}] stream error:`, msg);
				try {
					await writer.write(
						encoder.encode(
							`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } })}\n\n`,
						),
					);
				} catch {
					// ignore — writer may already be closed
				}
			} finally {
				release();
				try {
					await writer.close();
				} catch {
					// client disconnected
				}
				await provider.cleanup();
			}
		})();

		return new Response(readable, {
			headers: {
				...CORS_HEADERS,
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				'x-request-id': requestId,
			},
		});
	}
}
