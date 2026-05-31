import type { MessagesRequest, TextContentBlock } from './types';
import { stringifySystem } from './types';

export type RequestKind = 'normal' | 'tool_result' | 'skill_result' | 'rate_limited' | 'failed';

export interface TokenEstimates {
	estimated_context_tokens: number;
	estimated_prompt_tokens: number;
	estimated_tool_result_tokens: number;
}

export interface ProviderUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export interface TokenAccounting {
	estimated_context_tokens: number;
	estimated_prompt_tokens: number;
	estimated_tool_result_tokens: number;
	billable_input_tokens: number;
	billable_output_tokens: number;
	cached_input_tokens: number;
	failed_request_tokens: number;
	provider_usage_json?: string;
	provider_usage_found: boolean;
}

function estimateCharTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function toolResultText(content: string | TextContentBlock[]): string {
	return typeof content === 'string' ? content : content.map((block) => block.text).join('\n');
}

export function estimateRequestTokens(body: MessagesRequest): TokenEstimates {
	let contextChars = stringifySystem(body.system)?.length ?? 0;
	let promptChars = 0;
	let toolResultChars = 0;

	// Tool definitions are sent in every request and can be extremely large
	// (Claude Code sends 30+ tools with full JSON schemas).
	if (body.tools?.length) {
		contextChars += JSON.stringify(body.tools).length;
	}

	for (const msg of body.messages) {
		if (typeof msg.content === 'string') {
			contextChars += msg.content.length;
			if (msg.role === 'user') promptChars += msg.content.length;
			continue;
		}

		for (const block of msg.content) {
			if (block.type === 'text') {
				contextChars += block.text.length;
				if (msg.role === 'user') promptChars += block.text.length;
			} else if (block.type === 'tool_result') {
				const text = toolResultText(block.content);
				contextChars += text.length;
				toolResultChars += text.length;
			} else if (block.type === 'tool_use') {
				contextChars += block.name.length + JSON.stringify(block.input).length;
			}
		}
	}

	return {
		estimated_context_tokens: estimateCharTokens(contextChars),
		estimated_prompt_tokens: estimateCharTokens(promptChars),
		estimated_tool_result_tokens: estimateCharTokens(toolResultChars),
	};
}

export function classifyRequest(promptSnapshot: string | undefined, statusCode?: number, errorType?: string): RequestKind {
	if (statusCode === 429 || errorType === 'rate_limit_error') return 'rate_limited';
	if (statusCode !== undefined && statusCode >= 400) return 'failed';

	const prompt = promptSnapshot ?? '';
	if (prompt.includes('Launching skill:')) return 'skill_result';
	if (prompt.startsWith('[Result:')) return 'tool_result';
	return 'normal';
}

export function normalizeProviderUsage(raw: ProviderUsage | undefined): ProviderUsage | undefined {
	if (!raw) return undefined;
	const usage: ProviderUsage = {};
	if (Number.isFinite(raw.input_tokens)) usage.input_tokens = Number(raw.input_tokens);
	if (Number.isFinite(raw.output_tokens)) usage.output_tokens = Number(raw.output_tokens);
	if (Number.isFinite(raw.cache_creation_input_tokens)) {
		usage.cache_creation_input_tokens = Number(raw.cache_creation_input_tokens);
	}
	if (Number.isFinite(raw.cache_read_input_tokens)) usage.cache_read_input_tokens = Number(raw.cache_read_input_tokens);
	return Object.keys(usage).length ? usage : undefined;
}

export function mergeProviderUsage(current: ProviderUsage | undefined, next: ProviderUsage | undefined): ProviderUsage | undefined {
	const normalized = normalizeProviderUsage(next);
	if (!normalized) return current;
	return normalizeProviderUsage({
		input_tokens: normalized.input_tokens ?? current?.input_tokens,
		output_tokens: normalized.output_tokens ?? current?.output_tokens,
		cache_creation_input_tokens: normalized.cache_creation_input_tokens ?? current?.cache_creation_input_tokens,
		cache_read_input_tokens: normalized.cache_read_input_tokens ?? current?.cache_read_input_tokens,
	});
}

export function buildTokenAccounting(
	estimates: TokenEstimates,
	providerUsage: ProviderUsage | undefined,
	_estimatedOutputTokens: number,
	statusCode: number,
): TokenAccounting {
	const usage = normalizeProviderUsage(providerUsage);
	const provider_usage_found = usage !== undefined;
	const billable_input_tokens = usage?.input_tokens ?? 0;
	const billable_output_tokens = usage?.output_tokens ?? 0;
	const cached_input_tokens = (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
	const failed_request_tokens = statusCode >= 400 && !provider_usage_found ? estimates.estimated_context_tokens : 0;

	return {
		...estimates,
		billable_input_tokens: statusCode < 400 || provider_usage_found ? billable_input_tokens : 0,
		billable_output_tokens: statusCode < 400 || provider_usage_found ? billable_output_tokens : 0,
		cached_input_tokens,
		failed_request_tokens,
		provider_usage_json: usage ? JSON.stringify(usage) : undefined,
		provider_usage_found,
	};
}

export function hasRetryHeader(headers: Headers): boolean {
	for (const [key, value] of headers) {
		if (key.toLowerCase().includes('retry') && value !== '' && value !== '0') return true;
	}
	return false;
}
