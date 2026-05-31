// Parse Gemini SSE stream and emit Anthropic-format SSE via SSEBuilder

import { SSEBuilder } from '../../sse';
import { ProxyError } from '../../error';

interface GeminiStreamChunk {
	candidates?: Array<{
		content?: {
			parts?: Array<
				| { text: string; thought?: boolean }
				| { functionCall: { name: string; args: Record<string, unknown>; thought_signature?: string } }
			>;
			role?: string;
		};
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
}

interface BufferedToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	thoughtText?: string;
	thoughtSignature?: string;
}

export async function* streamGeminiResponse(
	resp: Response,
	builder: SSEBuilder,
	requestId: string,
): AsyncGenerator<string> {
	const reader = resp.body!.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let textBlockOpen = false;
	let stopReason: 'end_turn' | 'tool_use' = 'end_turn';
	let outputTokens = 0;
	let inputTokens: number | undefined;
	const toolCallsBuffer: BufferedToolCall[] = [];
	let thoughtBuf = '';

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
				if (!payload || payload === '[DONE]') continue;

				let chunk: GeminiStreamChunk;
				try {
					chunk = JSON.parse(payload) as GeminiStreamChunk;
				} catch {
					continue;
				}

				// Accumulate usage from every chunk — Gemini sends cumulative counts
				if (chunk.usageMetadata) {
					if (chunk.usageMetadata.candidatesTokenCount !== undefined) {
						outputTokens = chunk.usageMetadata.candidatesTokenCount;
					}
					if (chunk.usageMetadata.promptTokenCount !== undefined) {
						inputTokens = chunk.usageMetadata.promptTokenCount;
					}
				}

				const candidate = chunk.candidates?.[0];
				if (!candidate) continue;

				if (candidate.finishReason === 'SAFETY') {
					throw new ProxyError(400, 'invalid_request_error', 'Gemini blocked the response due to safety filters');
				}
				if (candidate.finishReason === 'STOP') stopReason = 'end_turn';
				if (candidate.finishReason === 'MAX_TOKENS') stopReason = 'end_turn';
				if (
					candidate.finishReason === 'FUNCTION_CALL' ||
					candidate.finishReason === 'TOOL_CALLS'
				) {
					stopReason = 'tool_use';
				}

				for (const part of candidate.content?.parts ?? []) {
					if ('text' in part && part.thought) {
						// Accumulate thought text — will be attached to the next function call
						thoughtBuf += part.text;
					} else if ('text' in part && part.text) {
						if (!textBlockOpen) {
							yield* builder.openTextBlock();
							textBlockOpen = true;
						}
						yield* builder.textDelta(part.text);
					} else if ('functionCall' in part) {
						// Detect tool use finish reason from presence of function calls
						stopReason = 'tool_use';
						toolCallsBuffer.push({
							id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
							name: part.functionCall.name,
							args: part.functionCall.args,
							thoughtText: thoughtBuf || undefined,
							thoughtSignature: part.functionCall.thought_signature,
						});
						thoughtBuf = '';
					}
				}
			}
		}
	} catch (err) {
		if (err instanceof ProxyError) throw err;
		const msg = err instanceof Error ? err.message : 'Gemini stream read error';
		console.error(`[${requestId}] Gemini stream error:`, msg);
		if (textBlockOpen) yield* builder.closeBlock();
		yield* builder.emitError(msg);
		return;
	}

	// Close text block if open
	if (textBlockOpen) yield* builder.closeBlock();

	// Emit buffered tool calls, each preceded by its thinking block if present
	for (const call of toolCallsBuffer) {
		if (call.thoughtSignature) {
			yield* builder.openThinkingBlock();
			if (call.thoughtText) yield* builder.thinkingDelta(call.thoughtText);
			yield* builder.signatureDelta(call.thoughtSignature);
			yield* builder.closeBlock();
		}
		yield* builder.openToolBlock(call.id, call.name);
		yield* builder.toolInputDelta(JSON.stringify(call.args));
		yield* builder.closeBlock();
	}

	// Emit messageStop with actual usage from Gemini if available
	const usage =
		inputTokens !== undefined || outputTokens > 0
			? { input_tokens: inputTokens ?? 0, output_tokens: outputTokens }
			: undefined;

	yield* builder.messageStop(stopReason, outputTokens, usage);
}
