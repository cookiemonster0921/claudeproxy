// SSEBuilder — emits Anthropic-format SSE event strings as sync generators

export class SSEBuilder {
	private blockIndex = 0;

	constructor(
		private readonly messageId: string,
		private readonly model: string,
		private readonly inputTokens: number,
	) {}

	*messageStart(): Generator<string> {
		yield this.frame('message_start', {
			type: 'message_start',
			message: {
				id: this.messageId,
				type: 'message',
				role: 'assistant',
				content: [],
				model: this.model,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: this.inputTokens, output_tokens: 0 },
			},
		});
		yield this.frame('ping', { type: 'ping' });
	}

	*openTextBlock(): Generator<string> {
		yield this.frame('content_block_start', {
			type: 'content_block_start',
			index: this.blockIndex,
			content_block: { type: 'text', text: '' },
		});
	}

	*textDelta(text: string): Generator<string> {
		yield this.frame('content_block_delta', {
			type: 'content_block_delta',
			index: this.blockIndex,
			delta: { type: 'text_delta', text },
		});
	}

	*openThinkingBlock(): Generator<string> {
		yield this.frame('content_block_start', {
			type: 'content_block_start',
			index: this.blockIndex,
			content_block: { type: 'thinking', thinking: '' },
		});
	}

	*thinkingDelta(thinking: string): Generator<string> {
		yield this.frame('content_block_delta', {
			type: 'content_block_delta',
			index: this.blockIndex,
			delta: { type: 'thinking_delta', thinking },
		});
	}

	*signatureDelta(signature: string): Generator<string> {
		yield this.frame('content_block_delta', {
			type: 'content_block_delta',
			index: this.blockIndex,
			delta: { type: 'signature_delta', signature },
		});
	}

	*openToolBlock(id: string, name: string): Generator<string> {
		yield this.frame('content_block_start', {
			type: 'content_block_start',
			index: this.blockIndex,
			content_block: { type: 'tool_use', id, name, input: {} },
		});
	}

	*toolInputDelta(partialJson: string): Generator<string> {
		yield this.frame('content_block_delta', {
			type: 'content_block_delta',
			index: this.blockIndex,
			delta: { type: 'input_json_delta', partial_json: partialJson },
		});
	}

	*closeBlock(): Generator<string> {
		yield this.frame('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
		this.blockIndex++;
	}

	*messageStop(
		stopReason: 'end_turn' | 'tool_use',
		outputTokens: number,
		usage?: Record<string, number>,
	): Generator<string> {
		yield this.frame('message_delta', {
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: usage ?? { output_tokens: outputTokens },
		});
		yield this.frame('message_stop', { type: 'message_stop' });
	}

	*emitError(message: string): Generator<string> {
		yield this.frame('error', { type: 'error', error: { type: 'api_error', message } });
	}

	private frame(event: string, data: unknown): string {
		return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}
}
