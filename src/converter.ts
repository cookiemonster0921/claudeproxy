import type { AnthropicTool, MessagesRequest, TextContentBlock, ToolUseContentBlock } from './types';
import { stringifySystem } from './types';

// OpenAI chat format types (internal to converter)
interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

interface OpenAITool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ConvertOptions {
	model: string;
}

export class AnthropicToOpenAIConverter {
	static convert(body: MessagesRequest, opts: ConvertOptions): Record<string, unknown> {
		const messages: OpenAIMessage[] = [];

		const systemText = stringifySystem(body.system);
		if (systemText) {
			messages.push({ role: 'system', content: systemText });
		}

		for (const msg of body.messages) {
			if (msg.role === 'user') {
				if (typeof msg.content === 'string') {
					messages.push({ role: 'user', content: msg.content });
				} else {
					const textParts: string[] = [];
					for (const block of msg.content) {
						if (block.type === 'text') {
							textParts.push(block.text);
						} else if (block.type === 'tool_result') {
							// Flush accumulated text before emitting tool result
							if (textParts.length) {
								messages.push({ role: 'user', content: textParts.join('\n') });
								textParts.length = 0;
							}
							const resultText =
								typeof block.content === 'string'
									? block.content
									: (block.content as TextContentBlock[]).map((b) => b.text).join('\n');
							messages.push({ role: 'tool', content: resultText, tool_call_id: block.tool_use_id });
						} else if (block.type === 'image') {
							textParts.push('[image omitted — not supported by this provider]');
						}
					}
					if (textParts.length) {
						messages.push({ role: 'user', content: textParts.join('\n') });
					}
				}
			} else {
				// assistant message
				if (typeof msg.content === 'string') {
					messages.push({ role: 'assistant', content: msg.content });
				} else {
					const textParts: string[] = [];
					const toolCalls: OpenAIToolCall[] = [];
					for (const block of msg.content) {
						if (block.type === 'text') {
							textParts.push((block as TextContentBlock).text);
						} else if (block.type === 'tool_use') {
							const b = block as ToolUseContentBlock;
							toolCalls.push({
								id: b.id,
								type: 'function',
								function: { name: b.name, arguments: JSON.stringify(b.input) },
							});
						}
					}
					const assistantMsg: OpenAIMessage = {
						role: 'assistant',
						content: textParts.join('\n') || null,
					};
					if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
					messages.push(assistantMsg);
				}
			}
		}

		const result: Record<string, unknown> = {
			model: opts.model,
			messages,
			max_tokens: body.max_tokens,
		};
		if (body.temperature !== undefined) result.temperature = body.temperature;
		if (body.tools?.length) result.tools = this.convertTools(body.tools);
		return result;
	}

	static convertTools(tools: AnthropicTool[]): OpenAITool[] {
		return tools.map((t) => ({
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description ?? '',
				parameters: t.input_schema ?? { type: 'object', properties: {} },
			},
		}));
	}
}
