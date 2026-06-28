// Web search via SearXNG — intercepts Anthropic server-side web_search tools
// and handles them locally so non-Anthropic providers can use web search.

import type { AnthropicTool, MessagesRequest, ContentBlock, ToolUseContentBlock } from './types';
import { parseAnthropicSSE } from './proxy-service';
import type { RoutedRequest } from './model-router';
import type { BaseProvider } from './providers/base';

export interface WebSearchResult {
	url: string;
	title: string;
	content: string;
}

const WEB_SEARCH_FUNCTION_TOOL: AnthropicTool = {
	name: 'web_search',
	description:
		'Search the web for current information. Returns relevant results with titles, URLs, and snippets.',
	input_schema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The search query' },
		},
		required: ['query'],
	},
};

export async function searchSearXNG(
	searxngUrl: string,
	query: string,
	maxResults = 5,
): Promise<WebSearchResult[]> {
	const url = new URL('/search', searxngUrl);
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'json');
	url.searchParams.set('categories', 'general');

	const resp = await fetch(url.toString(), {
		signal: AbortSignal.timeout(15_000),
	});

	if (!resp.ok) {
		throw new Error(`SearXNG returned ${resp.status}`);
	}

	const data = (await resp.json()) as { results?: WebSearchResult[] };
	return (data.results ?? []).slice(0, maxResults);
}

function formatSearchResults(results: WebSearchResult[]): string {
	if (!results.length) return 'No search results found.';
	return results
		.map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.content}`)
		.join('\n\n');
}

// Detect and strip server-side web_search tools from the request.
// Returns true if web_search was found (and the tools array was mutated).
export function extractWebSearchTools(body: MessagesRequest): boolean {
	if (!body.tools?.length) return false;

	const rawTools = body.tools as Array<AnthropicTool & { type?: string }>;
	const hasWebSearch = rawTools.some(
		(t) => typeof t.type === 'string' && t.type.startsWith('web_search'),
	);

	if (!hasWebSearch) return false;

	// Remove server-side web_search tools, add function tool equivalent
	body.tools = [
		...rawTools.filter((t) => !(typeof t.type === 'string' && t.type.startsWith('web_search'))),
		WEB_SEARCH_FUNCTION_TOOL,
	];

	return true;
}

// Run the web search agent loop: call model → if web_search tool_use → search → re-prompt → repeat.
// Returns the raw SSE chunks of the final response (no more web_search calls).
export async function runWebSearchLoop(
	body: MessagesRequest,
	routed: RoutedRequest,
	provider: BaseProvider,
	createProviderFn: () => BaseProvider,
	acquireRateLimiter: () => Promise<() => void>,
	searxngUrl: string,
	requestId: string,
	inputTokens: number,
	maxRounds = 3,
): Promise<string[]> {
	let currentProvider = provider;
	let round = 0;

	while (round++ < maxRounds) {
		const release = await acquireRateLimiter();
		let chunks: string[];
		try {
			chunks = [];
			for await (const chunk of currentProvider.streamResponse(routed, inputTokens, requestId)) {
				chunks.push(chunk);
			}
		} finally {
			release();
			await currentProvider.cleanup();
		}

		const parsed = parseAnthropicSSE(chunks.join(''), body.model, inputTokens);
		const webSearchCalls = parsed.message.content.filter(
			(b): b is ToolUseContentBlock =>
				b.type === 'tool_use' && (b as ToolUseContentBlock).name === 'web_search',
		);

		if (webSearchCalls.length === 0) {
			return chunks;
		}

		console.log(
			`[${requestId}] web-search round ${round}: ${webSearchCalls.length} search(es)`,
		);

		// Append assistant response to conversation
		body.messages.push({ role: 'assistant', content: parsed.message.content });

		// Perform searches and build tool results
		const toolResults: ContentBlock[] = [];
		for (const call of webSearchCalls) {
			const query = (call.input as Record<string, unknown>).query as string | undefined;
			if (!query) {
				toolResults.push({
					type: 'tool_result',
					tool_use_id: call.id,
					content: 'Error: query parameter is required',
				});
				continue;
			}

			try {
				const results = await searchSearXNG(searxngUrl, query);
				console.log(
					`[${requestId}] web-search query="${query}" results=${results.length}`,
				);
				toolResults.push({
					type: 'tool_result',
					tool_use_id: call.id,
					content: formatSearchResults(results),
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Search failed';
				console.error(`[${requestId}] web-search error:`, msg);
				toolResults.push({
					type: 'tool_result',
					tool_use_id: call.id,
					content: `Web search failed: ${msg}`,
				});
			}
		}

		// Also provide empty results for any non-web-search tool calls so the
		// model doesn't stall waiting for results that will never come.
		const otherToolCalls = parsed.message.content.filter(
			(b): b is ToolUseContentBlock =>
				b.type === 'tool_use' && (b as ToolUseContentBlock).name !== 'web_search',
		);
		for (const call of otherToolCalls) {
			toolResults.push({
				type: 'tool_result',
				tool_use_id: call.id,
				content: '[Tool result pending — will be executed after web search completes]',
			});
		}

		body.messages.push({ role: 'user', content: toolResults });

		// Rebuild routed request with updated body
		routed = { body, resolved: routed.resolved };
		currentProvider = createProviderFn();
	}

	// If we exhausted rounds, return the last response as-is
	const release = await acquireRateLimiter();
	try {
		const chunks: string[] = [];
		for await (const chunk of currentProvider.streamResponse(routed, inputTokens, requestId)) {
			chunks.push(chunk);
		}
		return chunks;
	} finally {
		release();
		await currentProvider.cleanup();
	}
}
