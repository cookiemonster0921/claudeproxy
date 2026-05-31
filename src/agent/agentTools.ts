// Tool definitions and executor functions for the GoalWorkflow

import type { AnthropicTool } from '../types';

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic format)
// ---------------------------------------------------------------------------

export function buildTools(): AnthropicTool[] {
	return [
		{
			name: 'web_fetch',
			description: 'Fetch a URL and return its content. Use for reading documentation, APIs, or web pages.',
			input_schema: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'URL to fetch' },
					method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
					headers: { type: 'object', description: 'Optional HTTP headers' },
					body: { type: 'string', description: 'Optional request body (for POST/PUT)' },
				},
				required: ['url'],
			},
		},
		{
			name: 'web_search',
			description: 'Search the web for information. Use to find documentation, examples, or solutions.',
			input_schema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Search query' },
				},
				required: ['query'],
			},
		},
		{
			name: 'valtown_create_val',
			description: 'Create a new Val Town val (script, HTTP endpoint, or cron job).',
			input_schema: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Val name (e.g., "myHttpEndpoint")' },
					code: { type: 'string', description: 'Val source code' },
					type: { type: 'string', description: 'Val type', enum: ['script', 'http', 'cron', 'email'] },
					privacy: { type: 'string', description: 'Privacy setting', enum: ['public', 'unlisted', 'private'] },
				},
				required: ['name', 'code', 'type'],
			},
		},
		{
			name: 'valtown_run_val',
			description: 'Run a Val Town val by ID or handle (username/valname) and return the output.',
			input_schema: {
				type: 'object',
				properties: {
					val_ref: { type: 'string', description: 'Val ID or handle (e.g., "username/valname")' },
					args: { type: 'array', description: 'Arguments to pass to the val', items: {} },
				},
				required: ['val_ref'],
			},
		},
		{
			name: 'valtown_edit_val',
			description: 'Edit an existing Val Town val by ID.',
			input_schema: {
				type: 'object',
				properties: {
					val_id: { type: 'string', description: 'Val ID to edit' },
					code: { type: 'string', description: 'New source code' },
					name: { type: 'string', description: 'New name (optional)' },
				},
				required: ['val_id', 'code'],
			},
		},
		{
			name: 'valtown_list_vals',
			description: 'List your Val Town vals.',
			input_schema: {
				type: 'object',
				properties: {
					limit: { type: 'number', description: 'Max results (default: 20)' },
					offset: { type: 'number', description: 'Pagination offset' },
				},
			},
		},
		{
			name: 'valtown_read_val',
			description: 'Read the source code and metadata of a Val Town val by ID.',
			input_schema: {
				type: 'object',
				properties: {
					val_id: { type: 'string', description: 'Val ID' },
				},
				required: ['val_id'],
			},
		},
		{
			name: 'http_request',
			description: 'Make an arbitrary HTTP request to any URL. Use for API calls.',
			input_schema: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'Request URL' },
					method: { type: 'string', description: 'HTTP method', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'] },
					headers: { type: 'object', description: 'HTTP headers' },
					body: { type: 'string', description: 'Request body (JSON string)' },
				},
				required: ['url', 'method'],
			},
		},
		{
			name: 'github_read_file',
			description: 'Read a file from a public GitHub repository.',
			input_schema: {
				type: 'object',
				properties: {
					owner: { type: 'string', description: 'Repository owner' },
					repo: { type: 'string', description: 'Repository name' },
					path: { type: 'string', description: 'File path within the repo' },
					ref: { type: 'string', description: 'Branch, tag, or commit (default: main)' },
				},
				required: ['owner', 'repo', 'path'],
			},
		},
	];
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export interface ToolEnv {
	VALTOWN_API_KEY?: string;
	GITHUB_TOKEN?: string;
}

export async function executeTool(
	name: string,
	input: Record<string, unknown>,
	env: ToolEnv,
): Promise<string> {
	switch (name) {
		case 'web_fetch':
			return toolWebFetch(input);
		case 'web_search':
			return toolWebSearch(input);
		case 'valtown_create_val':
			return toolValtownCreateVal(input, env.VALTOWN_API_KEY);
		case 'valtown_run_val':
			return toolValtownRunVal(input, env.VALTOWN_API_KEY);
		case 'valtown_edit_val':
			return toolValtownEditVal(input, env.VALTOWN_API_KEY);
		case 'valtown_list_vals':
			return toolValtownListVals(input, env.VALTOWN_API_KEY);
		case 'valtown_read_val':
			return toolValtownReadVal(input, env.VALTOWN_API_KEY);
		case 'http_request':
			return toolHttpRequest(input);
		case 'github_read_file':
			return toolGithubReadFile(input, env.GITHUB_TOKEN);
		default:
			return `Error: Unknown tool "${name}"`;
	}
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolWebFetch(input: Record<string, unknown>): Promise<string> {
	const url = input.url as string;
	const method = (input.method as string | undefined) ?? 'GET';
	const headers = (input.headers as Record<string, string> | undefined) ?? {};
	const body = input.body as string | undefined;

	try {
		const resp = await fetch(url, {
			method,
			headers: { 'User-Agent': 'claude-agent/1.0', ...headers },
			body: body ?? undefined,
		});
		const text = await resp.text();
		const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n\n[...truncated]' : text;
		return `HTTP ${resp.status} ${resp.statusText}\n\n${truncated}`;
	} catch (e) {
		return `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
}

async function toolWebSearch(input: Record<string, unknown>): Promise<string> {
	const query = input.query as string;
	// Use DuckDuckGo instant answer API (no key required)
	try {
		const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
		const resp = await fetch(url, { headers: { 'User-Agent': 'claude-agent/1.0' } });
		const data = (await resp.json()) as {
			AbstractText?: string;
			AbstractURL?: string;
			RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
			Answer?: string;
		};

		const parts: string[] = [];
		if (data.Answer) parts.push(`Answer: ${data.Answer}`);
		if (data.AbstractText) parts.push(`Summary: ${data.AbstractText}`);
		if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`);
		if (data.RelatedTopics?.length) {
			const topics = data.RelatedTopics
				.slice(0, 5)
				.filter((t) => t.Text)
				.map((t) => `- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ''}`)
				.join('\n');
			if (topics) parts.push(`Related:\n${topics}`);
		}

		return parts.length > 0
			? parts.join('\n\n')
			: `No instant answer found for: "${query}". Try web_fetch with a specific URL.`;
	} catch (e) {
		return `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
}

const VALTOWN_API = 'https://api.val.town/v1';

async function valtownFetch(
	path: string,
	method: string,
	apiKey: string | undefined,
	body?: unknown,
): Promise<string> {
	if (!apiKey) return 'Error: VALTOWN_API_KEY is not configured';
	try {
		const resp = await fetch(`${VALTOWN_API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		if (!resp.ok) return `Error ${resp.status}: ${text}`;
		return text;
	} catch (e) {
		return `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
}

async function toolValtownCreateVal(
	input: Record<string, unknown>,
	apiKey: string | undefined,
): Promise<string> {
	return valtownFetch('/vals', 'POST', apiKey, {
		name: input.name,
		code: input.code,
		type: input.type ?? 'script',
		privacy: input.privacy ?? 'unlisted',
	});
}

async function toolValtownRunVal(
	input: Record<string, unknown>,
	apiKey: string | undefined,
): Promise<string> {
	const ref = input.val_ref as string;
	const args = (input.args as unknown[]) ?? [];
	// If it looks like a UUID, use /vals/{id}/run, otherwise resolve by handle
	if (/^[0-9a-f-]{36}$/i.test(ref)) {
		return valtownFetch(`/vals/${ref}/run`, 'POST', apiKey, { args });
	}
	// Handle format: username/valname — first resolve then run
	const infoResp = await valtownFetch(`/alias/${ref}`, 'GET', apiKey);
	try {
		const info = JSON.parse(infoResp) as { id?: string };
		if (!info.id) return `Error: could not resolve val "${ref}"`;
		return valtownFetch(`/vals/${info.id}/run`, 'POST', apiKey, { args });
	} catch {
		return infoResp;
	}
}

async function toolValtownEditVal(
	input: Record<string, unknown>,
	apiKey: string | undefined,
): Promise<string> {
	const id = input.val_id as string;
	const body: Record<string, unknown> = { code: input.code };
	if (input.name) body.name = input.name;
	return valtownFetch(`/vals/${id}`, 'PATCH', apiKey, body);
}

async function toolValtownListVals(
	input: Record<string, unknown>,
	apiKey: string | undefined,
): Promise<string> {
	const limit = (input.limit as number | undefined) ?? 20;
	const offset = (input.offset as number | undefined) ?? 0;
	return valtownFetch(`/me/vals?limit=${limit}&offset=${offset}`, 'GET', apiKey);
}

async function toolValtownReadVal(
	input: Record<string, unknown>,
	apiKey: string | undefined,
): Promise<string> {
	return valtownFetch(`/vals/${input.val_id}`, 'GET', apiKey);
}

async function toolHttpRequest(input: Record<string, unknown>): Promise<string> {
	const url = input.url as string;
	const method = input.method as string;
	const headers = (input.headers as Record<string, string> | undefined) ?? {};
	const body = input.body as string | undefined;

	try {
		const resp = await fetch(url, {
			method,
			headers: { 'User-Agent': 'claude-agent/1.0', ...headers },
			body: body ?? undefined,
		});
		const text = await resp.text();
		const truncated = text.length > 4000 ? text.slice(0, 4000) + '\n[...truncated]' : text;
		return `HTTP ${resp.status} ${resp.statusText}\n${truncated}`;
	} catch (e) {
		return `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
}

async function toolGithubReadFile(
	input: Record<string, unknown>,
	githubToken?: string,
): Promise<string> {
	const { owner, repo, path, ref = 'main' } = input as {
		owner: string;
		repo: string;
		path: string;
		ref?: string;
	};

	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'claude-agent/1.0',
	};
	if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

	try {
		const resp = await fetch(url, { headers });
		if (!resp.ok) {
			const text = await resp.text();
			return `Error ${resp.status}: ${text}`;
		}
		const data = (await resp.json()) as { content?: string; encoding?: string; message?: string };
		if (data.message) return `Error: ${data.message}`;
		if (data.encoding === 'base64' && data.content) {
			const decoded = atob(data.content.replace(/\n/g, ''));
			return decoded.length > 8000 ? decoded.slice(0, 8000) + '\n[...truncated]' : decoded;
		}
		return JSON.stringify(data);
	} catch (e) {
		return `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
}
