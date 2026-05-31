import type {
	MessagesRequest,
	AnthropicMessage,
	SystemContentBlock,
	AnthropicTool,
	AnthropicAssistantResponse,
	TextContentBlock,
	ToolUseContentBlock,
	WorkersAiMessage,
	WorkersAiResponse,
	WorkersAiTool,
	WorkersAiToolCall,
	WorkersAiRequest,
} from '../types';
import { stringifySystem, withTimeout } from '../types';
import { SSEBuilder } from '../sse';
import type { BaseProvider } from './base';
import type { RoutedRequest } from '../model-router';

// ---------------------------------------------------------------------------
// Message conversion helpers (Workers AI specific)
// ---------------------------------------------------------------------------

function convertMessages(messages: AnthropicMessage[], system?: string | SystemContentBlock[]): WorkersAiMessage[] {
	const result: WorkersAiMessage[] = [];
	const systemText = stringifySystem(system);
	if (systemText) result.push({ role: 'system', content: systemText });

	for (const msg of messages) {
		const { role, content } = msg;
		if (typeof content === 'string') {
			result.push({ role, content });
			continue;
		}
		const parts: string[] = [];
		for (const block of content) {
			switch (block.type) {
				case 'text':
					parts.push((block as TextContentBlock).text);
					break;
				case 'image':
					parts.push('[image content not supported]');
					break;
				case 'tool_use': {
					const b = block as ToolUseContentBlock;
					parts.push(`[Tool call: ${b.name}(${JSON.stringify(b.input)})]`);
					break;
				}
				case 'tool_result': {
					const resultText =
						typeof block.content === 'string'
							? block.content
							: (block.content as TextContentBlock[]).map((b) => b.text).join('\n');
					parts.push(`[Tool result for ${block.tool_use_id}]: ${resultText}`);
					break;
				}
			}
		}
		result.push({ role, content: parts.join('\n') });
	}
	return result;
}

function convertTools(tools?: AnthropicTool[]): WorkersAiTool[] | undefined {
	if (!tools?.length) return undefined;
	const converted = tools
		.filter((t) => typeof t.name === 'string' && t.name.length > 0)
		.map((t) => ({
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description ?? '',
				parameters: t.input_schema ?? { type: 'object', properties: {} },
			},
		}));
	return converted.length > 0 ? converted : undefined;
}

function buildAiRequest(body: MessagesRequest, messages: WorkersAiMessage[]): WorkersAiRequest {
	const req: WorkersAiRequest = { messages, max_tokens: body.max_tokens };
	if (typeof body.temperature === 'number') req.temperature = body.temperature;
	const tools = convertTools(body.tools);
	if (tools) req.tools = tools;
	return req;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		return input as Record<string, unknown>;
	}
	if (typeof input === 'string') {
		try {
			const parsed: unknown = JSON.parse(input);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return {};
		}
	}
	return {};
}

function buildAnthropicMessage(
	result: WorkersAiResponse,
	responseModel: string,
	inputTokens: number,
): AnthropicAssistantResponse {
	const text = result.response ?? '';
	const outputTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);
	const content: Array<TextContentBlock | ToolUseContentBlock> = [];

	if (text.length > 0) content.push({ type: 'text', text });

	for (const call of result.tool_calls ?? []) {
		if (!call.name) continue;
		content.push({
			type: 'tool_use',
			id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
			name: call.name,
			input: normalizeToolInput(call.arguments),
		});
	}

	if (content.length === 0) content.push({ type: 'text', text: '' });

	return {
		id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
		type: 'message',
		role: 'assistant',
		content,
		model: responseModel,
		stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
		stop_sequence: null,
		usage: {
			input_tokens: result.usage?.prompt_tokens ?? inputTokens,
			output_tokens: outputTokens,
		},
	};
}

function normalizeAiResult(raw: WorkersAiResponse | WorkersAiToolCall | string): WorkersAiResponse {
	if (typeof raw === 'string') return { response: raw };
	return raw as WorkersAiResponse;
}

// ---------------------------------------------------------------------------
// WorkersAiProvider
// ---------------------------------------------------------------------------

const WORKERS_AI_TIMEOUT_MS = 30_000;
const STREAM_CHUNK_SIZE = 20;

// Context window limits per model. Workers AI includes both input AND max_tokens
// in this budget. Claude Code ships 30+ tool schemas per request (~60-70k tokens),
// so we strip tools pre-emptively when the estimate would overflow.
const WORKERS_AI_CONTEXT_WINDOWS: Record<string, number> = {
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast': 24_000,
	'@cf/meta/llama-3.1-8b-instruct': 8_192,
	'@cf/qwen/qwen2.5-coder-32b-instruct': 32_768,
};
const WORKERS_AI_DEFAULT_CONTEXT = 24_000;
// Keep at least this many tokens free for the model's output.
const WORKERS_AI_MIN_OUTPUT_BUDGET = 512;

function fitRequestToContext(
	aiRequest: WorkersAiRequest,
	messageTokens: number,
	providerModel: string,
	requestId: string,
): void {
	const contextWindow = WORKERS_AI_CONTEXT_WINDOWS[providerModel] ?? WORKERS_AI_DEFAULT_CONTEXT;
	const toolTokens = aiRequest.tools ? Math.ceil(JSON.stringify(aiRequest.tools).length / 4) : 0;
	const currentMax = aiRequest.max_tokens ?? 512;

	// Step 1: cap max_tokens so input + output ≤ context window.
	const maxAfterMessages = contextWindow - messageTokens - toolTokens - 1;
	if (maxAfterMessages < currentMax) {
		const capped = Math.max(WORKERS_AI_MIN_OUTPUT_BUDGET, maxAfterMessages);
		console.warn(
			`[${requestId}] capping max_tokens ${currentMax}→${capped} (context ${contextWindow}, ~${messageTokens + toolTokens} input tokens)`,
		);
		aiRequest.max_tokens = capped;
	}

	// Step 2: if tool definitions alone push us over the limit, drop them.
	// Workers AI llama models have a 24k window; Claude Code's 30+ tool schemas
	// typically occupy 60-70k tokens — they can never fit.
	if (toolTokens > 0 && messageTokens + toolTokens + (aiRequest.max_tokens ?? 512) > contextWindow) {
		console.warn(
			`[${requestId}] stripping ${aiRequest.tools?.length ?? 0} tools (~${toolTokens} tok): ` +
				`estimated input ${messageTokens + toolTokens} exceeds ${contextWindow} context window`,
		);
		delete aiRequest.tools;
		// Re-apply max_tokens cap without tool overhead.
		const maxWithoutTools = contextWindow - messageTokens - 1;
		aiRequest.max_tokens = Math.min(
			aiRequest.max_tokens ?? 512,
			Math.max(WORKERS_AI_MIN_OUTPUT_BUDGET, maxWithoutTools),
		);
	}
}

export class WorkersAiProvider implements BaseProvider {
	constructor(private readonly ai: Ai) {}

	preflight(_body: MessagesRequest): void {
		// no-op — Workers AI validates at call time
	}

	async *streamResponse(routed: RoutedRequest, inputTokens: number, requestId: string): AsyncGenerator<string> {
		const { body, resolved } = routed;
		const messages = convertMessages(body.messages, body.system);
		const aiRequest = buildAiRequest(body, messages);
		fitRequestToContext(aiRequest, inputTokens, resolved.providerModel, requestId);
		const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
		const builder = new SSEBuilder(messageId, body.model, inputTokens);

		yield* builder.messageStart();

		let rawResult: WorkersAiResponse | WorkersAiToolCall | string;
		try {
			rawResult = await withTimeout(
				this.ai.run(resolved.providerModel as Parameters<typeof this.ai.run>[0], aiRequest) as Promise<
					WorkersAiResponse | WorkersAiToolCall | string
				>,
				WORKERS_AI_TIMEOUT_MS,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Workers AI call failed';
			console.error(`[${requestId}] Workers AI error:`, msg);
			yield* builder.emitError(msg);
			return;
		}

		const normalizedResult = normalizeAiResult(rawResult);
		const message = buildAnthropicMessage(normalizedResult, body.model, inputTokens);

		for (const block of message.content) {
			if (block.type === 'text') {
				yield* builder.openTextBlock();
				for (let i = 0; i < block.text.length; i += STREAM_CHUNK_SIZE) {
					yield* builder.textDelta(block.text.slice(i, i + STREAM_CHUNK_SIZE));
				}
				yield* builder.closeBlock();
			} else {
				yield* builder.openToolBlock(block.id, block.name);
				yield* builder.toolInputDelta(JSON.stringify(block.input));
				yield* builder.closeBlock();
			}
		}

		yield* builder.messageStop(
			message.stop_reason,
			message.usage.output_tokens,
			normalizedResult.usage
				? {
						input_tokens: message.usage.input_tokens,
						output_tokens: message.usage.output_tokens,
					}
				: undefined,
		);
	}

	async cleanup(): Promise<void> {
		// no-op
	}
}
