import type { Env, MessagesRequest, AnthropicAssistantResponse, TextContentBlock, ToolUseContentBlock } from './types';
import { CORS_HEADERS, approxTokens, jsonResponse } from './types';
import type { Settings } from './config';
import { ProxyError } from './error';
import type { AnalyticsContext } from './analytics';
import { ModelRouter } from './model-router';
import { GlobalRateLimiter } from './rate-limit';
import { createProvider } from './providers/registry';
import {
	buildTokenAccounting,
	classifyRequest,
	estimateRequestTokens,
	mergeProviderUsage,
	type ProviderUsage,
} from './token-accounting';
import { extractWebSearchTools, runWebSearchLoop } from './web-search';

// ---------------------------------------------------------------------------
// Snapshot extraction helpers — first N chars only, never full content
// ---------------------------------------------------------------------------

const SNAP = 200; // max chars per snapshot

function snap(text: string): string {
	return text.length > SNAP ? text.slice(0, SNAP) + '…' : text;
}

function extractPromptSnapshot(body: MessagesRequest): string | undefined {
	// Walk messages in reverse to find the last user message
	for (let i = body.messages.length - 1; i >= 0; i--) {
		const msg = body.messages[i];
		if (msg.role !== 'user') continue;

		const { content } = msg;
		if (typeof content === 'string') return snap(content.trim());

		const parts: string[] = [];
		for (const block of content) {
			if (block.type === 'text' && (block as TextContentBlock).text.trim()) {
				parts.push((block as TextContentBlock).text.trim());
			} else if (block.type === 'tool_result') {
				const resultText =
					typeof block.content === 'string'
						? block.content
						: (block.content as TextContentBlock[]).map((b) => b.text).join(' ');
				if (resultText.trim()) parts.push('[Result: ' + resultText.trim() + ']');
			}
		}
		const joined = parts.join(' ').trim();
		if (joined) return snap(joined);
	}
	return undefined;
}

function extractResponseSnapshot(message: AnthropicAssistantResponse): string | undefined {
	for (const block of message.content) {
		if (block.type === 'text' && (block as TextContentBlock).text.trim()) {
			return snap((block as TextContentBlock).text.trim());
		}
	}
	return undefined;
}

function extractToolSnapshot(message: AnthropicAssistantResponse): string | undefined {
	const tools = message.content.filter((b) => b.type === 'tool_use') as ToolUseContentBlock[];
	if (!tools.length) return undefined;
	const preview = tools.map((t) => {
		const argsJson = JSON.stringify(t.input);
		return { name: t.name, args: argsJson.length > SNAP ? argsJson.slice(0, SNAP) + '…' : argsJson };
	});
	return JSON.stringify(preview);
}

// Parse buffered SSE text into an AnthropicAssistantResponse (for non-streaming path)
interface ParsedSse {
	message: AnthropicAssistantResponse;
	providerUsage: ProviderUsage | undefined;
	estimatedOutputTokens: number;
	errorType: string | undefined;
}

function usageFromRecord(record: Record<string, unknown> | undefined): ProviderUsage | undefined {
	if (!record) return undefined;
	return {
		input_tokens: typeof record.input_tokens === 'number' ? record.input_tokens : undefined,
		output_tokens: typeof record.output_tokens === 'number' ? record.output_tokens : undefined,
		cache_creation_input_tokens:
			typeof record.cache_creation_input_tokens === 'number' ? record.cache_creation_input_tokens : undefined,
		cache_read_input_tokens: typeof record.cache_read_input_tokens === 'number' ? record.cache_read_input_tokens : undefined,
	};
}

export function parseAnthropicSSE(
	sseText: string,
	fallbackModel: string,
	fallbackInputTokens: number,
): ParsedSse {
	let messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
	let parsedModel = fallbackModel;
	let stopReason: 'end_turn' | 'tool_use' = 'end_turn';
	let outputTokens = 0;
	let parsedInputTokens = fallbackInputTokens;
	let providerUsage: ProviderUsage | undefined;
	let errorType: string | undefined;

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
						const usage = usageFromRecord(msg.usage as Record<string, unknown> | undefined);
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
					const parsedUsage = usageFromRecord(usage as Record<string, unknown> | undefined);
					if (parsedUsage?.output_tokens) outputTokens = parsedUsage.output_tokens;
					providerUsage = mergeProviderUsage(providerUsage, parsedUsage);
				} else if (type === 'error') {
					const error = event.error as Record<string, unknown> | undefined;
					errorType = typeof error?.type === 'string' ? error.type : 'api_error';
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

	const estimatedOutputTokens = Math.ceil(
		content.reduce((sum, block) => (block.type === 'text' ? sum + block.text.length : sum), 0) / 4,
	);

	return {
		message: {
			id: messageId,
			type: 'message',
			role: 'assistant',
			content,
			model: parsedModel,
			stop_reason: stopReason,
			stop_sequence: null,
			usage: {
				input_tokens: providerUsage?.input_tokens ?? parsedInputTokens,
				output_tokens: providerUsage?.output_tokens ?? outputTokens,
				...(providerUsage?.cache_creation_input_tokens !== undefined
					? { cache_creation_input_tokens: providerUsage.cache_creation_input_tokens }
					: {}),
				...(providerUsage?.cache_read_input_tokens !== undefined
					? { cache_read_input_tokens: providerUsage.cache_read_input_tokens }
					: {}),
			},
		},
		providerUsage,
		estimatedOutputTokens,
		errorType,
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

	async handleMessages(
		body: MessagesRequest,
		requestId: string,
		analyticsCtx?: AnalyticsContext,
	): Promise<Response> {
		if (!body.messages?.length) {
			throw new ProxyError(400, 'invalid_request_error', 'messages array must not be empty');
		}

		// Intercept server-side web_search tools for non-Anthropic providers.
		// When SEARXNG_URL is configured, web_search is handled by the proxy via SearXNG.
		const searxngUrl = this.env.SEARXNG_URL;
		const hasWebSearch = searxngUrl ? extractWebSearchTools(body) : false;

		const routed = this.router.resolveRequest(body);
		const provider = createProvider(routed.resolved.providerId, this.settings, this.env);
		provider.preflight(body);

		const inputTokens = approxTokens(body);
		const estimates = estimateRequestTokens(body);
		const stream = body.stream ?? false;

		// Populate analytics context with routing data and prompt snapshot
		if (analyticsCtx) {
			analyticsCtx.model = body.model;
			analyticsCtx.provider = routed.resolved.providerId;
			analyticsCtx.stream = stream;
			analyticsCtx.estimatedContextTokens = estimates.estimated_context_tokens;
			analyticsCtx.estimatedPromptTokens = estimates.estimated_prompt_tokens;
			analyticsCtx.estimatedToolResultTokens = estimates.estimated_tool_result_tokens;
			analyticsCtx.promptSnapshot = extractPromptSnapshot(body);
			analyticsCtx.requestKind = classifyRequest(analyticsCtx.promptSnapshot);
		}

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
				webSearch: hasWebSearch,
				ts: new Date().toISOString(),
			}),
		);

		// Web search agent loop: buffer internally, perform SearXNG searches,
		// re-prompt until the model produces a final response without web_search calls.
		if (hasWebSearch && searxngUrl) {
			const finalChunks = await runWebSearchLoop(
				body,
				routed,
				provider,
				() => createProvider(routed.resolved.providerId, this.settings, this.env),
				() => this.rateLimiter.acquire(),
				searxngUrl,
				requestId,
				inputTokens,
			);

			if (!stream) {
				const parsed = parseAnthropicSSE(finalChunks.join(''), body.model, inputTokens);
				return jsonResponse(parsed.message, requestId);
			}

			// Re-emit buffered SSE as streaming response
			return new Response(finalChunks.join(''), {
				headers: {
					...CORS_HEADERS,
					'Content-Type': 'text/event-stream; charset=utf-8',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					'x-request-id': requestId,
				},
			});
		}

		if (!stream) {
			// Non-streaming: buffer all SSE, parse into JSON response
			const release = await this.rateLimiter.acquire();
			try {
				const chunks: string[] = [];
				for await (const chunk of provider.streamResponse(routed, inputTokens, requestId)) {
					chunks.push(chunk);
				}
				const parsed = parseAnthropicSSE(chunks.join(''), body.model, inputTokens);
				const { message } = parsed;
				// Record output tokens and response/tool snapshots for analytics
				if (analyticsCtx) {
					if (parsed.errorType) analyticsCtx.errorType = parsed.errorType;
					const accountingStatus = parsed.errorType
						? parsed.errorType === 'rate_limit_error'
							? 429
							: 500
						: 200;
					const accounting = buildTokenAccounting(
						estimates,
						parsed.providerUsage,
						parsed.estimatedOutputTokens,
						accountingStatus,
					);
					analyticsCtx.billableInputTokens = accounting.billable_input_tokens;
					analyticsCtx.billableOutputTokens = accounting.billable_output_tokens;
					analyticsCtx.cachedInputTokens = accounting.cached_input_tokens;
					analyticsCtx.failedRequestTokens = accounting.failed_request_tokens;
					analyticsCtx.estimatedOutputTokens = parsed.estimatedOutputTokens;
					analyticsCtx.providerUsageJson = accounting.provider_usage_json;
					analyticsCtx.providerUsageFound = accounting.provider_usage_found;
					analyticsCtx.requestKind = classifyRequest(analyticsCtx.promptSnapshot, accountingStatus, analyticsCtx.errorType);
					analyticsCtx.responseSnapshot = extractResponseSnapshot(message);
					analyticsCtx.toolSnapshot = extractToolSnapshot(message);
				}
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

		let resolveCompletion: (() => void) | undefined;
		if (analyticsCtx) {
			analyticsCtx.completion = new Promise<void>((resolve) => {
				resolveCompletion = resolve;
			});
		}

		(async () => {
			const release = await this.rateLimiter.acquire();
			const chunks: string[] = [];
			try {
				for await (const chunk of provider.streamResponse(routed, inputTokens, requestId)) {
					chunks.push(chunk);
					await writer.write(encoder.encode(chunk));
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Provider error';
				if (analyticsCtx) {
					analyticsCtx.errorType = err instanceof ProxyError ? err.errorType : 'api_error';
				}
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
				if (analyticsCtx) {
					const parsed = parseAnthropicSSE(chunks.join(''), body.model, inputTokens);
					if (parsed.errorType) analyticsCtx.errorType = parsed.errorType;
					const accountingStatus = analyticsCtx.errorType
						? analyticsCtx.errorType === 'rate_limit_error'
							? 429
							: 500
						: 200;
					const accounting = buildTokenAccounting(
						estimates,
						parsed.providerUsage,
						parsed.estimatedOutputTokens,
						accountingStatus,
					);
					analyticsCtx.billableInputTokens = accounting.billable_input_tokens;
					analyticsCtx.billableOutputTokens = accounting.billable_output_tokens;
					analyticsCtx.cachedInputTokens = accounting.cached_input_tokens;
					analyticsCtx.failedRequestTokens = accounting.failed_request_tokens;
					analyticsCtx.estimatedOutputTokens = parsed.estimatedOutputTokens;
					analyticsCtx.providerUsageJson = accounting.provider_usage_json;
					analyticsCtx.providerUsageFound = accounting.provider_usage_found;
					analyticsCtx.requestKind = classifyRequest(analyticsCtx.promptSnapshot, accountingStatus, analyticsCtx.errorType);
					analyticsCtx.responseSnapshot = extractResponseSnapshot(parsed.message);
					analyticsCtx.toolSnapshot = extractToolSnapshot(parsed.message);
					resolveCompletion?.();
				}
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
