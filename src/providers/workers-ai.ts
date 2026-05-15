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

export class WorkersAiProvider implements BaseProvider {
	constructor(private readonly ai: Ai) {}

	preflight(_body: MessagesRequest): void {
		// no-op — Workers AI validates at call time
	}

	async *streamResponse(routed: RoutedRequest, inputTokens: number, requestId: string): AsyncGenerator<string> {
		const { body, resolved } = routed;
		const messages = convertMessages(body.messages, body.system);
		const aiRequest = buildAiRequest(body, messages);
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

		const message = buildAnthropicMessage(normalizeAiResult(rawResult), body.model, inputTokens);

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

		yield* builder.messageStop(message.stop_reason, message.usage.output_tokens);
	}

	async cleanup(): Promise<void> {
		// no-op
	}
}
