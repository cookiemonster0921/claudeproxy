import { describe, it, expect } from 'vitest';
import { convertToGemini } from '../src/providers/gemini/transform';
import { mapGeminiError } from '../src/providers/gemini/errors';
import type { MessagesRequest } from '../src/types';

// ---------------------------------------------------------------------------
// convertToGemini — request transformation
// ---------------------------------------------------------------------------

describe('convertToGemini — request transformation', () => {
	it('maps system prompt to systemInstruction', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			system: 'You are a helpful assistant.',
			messages: [{ role: 'user', content: 'hi' }],
		};
		const result = convertToGemini(body);
		expect(result.systemInstruction).toEqual({ parts: [{ text: 'You are a helpful assistant.' }] });
	});

	it('maps assistant role to model role', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: 'hello' },
			],
		};
		const result = convertToGemini(body);
		expect(result.contents[0].role).toBe('user');
		expect(result.contents[1].role).toBe('model');
	});

	it('converts tool_use content blocks to functionCall parts', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [
				{ role: 'user', content: 'call a tool' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_abc',
							name: 'get_weather',
							input: { city: 'Tokyo' },
						},
					],
				},
			],
		};
		const result = convertToGemini(body);
		const assistantContent = result.contents[1];
		expect(assistantContent.role).toBe('model');
		const part = assistantContent.parts[0] as { functionCall: { name: string; args: Record<string, unknown> } };
		expect(part.functionCall.name).toBe('get_weather');
		expect(part.functionCall.args).toEqual({ city: 'Tokyo' });
	});

	it('converts tool_result content blocks to functionResponse parts using the function name (not the ID)', () => {
		// The conversation includes a prior assistant tool_use so the id→name map is populated.
		// Gemini requires functionResponse.name = function name (e.g. "get_weather"),
		// NOT the Anthropic tool call ID (e.g. "toolu_abc").
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [
				{ role: 'user', content: 'What is the weather?' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_abc',
							name: 'get_weather',
							input: { city: 'Tokyo' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_abc',
							content: 'Sunny, 25°C',
						},
					],
				},
			],
		};
		const result = convertToGemini(body);
		const toolResultContent = result.contents[2]; // third message
		const part = toolResultContent.parts[0] as {
			functionResponse: { name: string; response: { content: string } };
		};
		// Must be the function NAME, not the tool use ID
		expect(part.functionResponse.name).toBe('get_weather');
		expect(part.functionResponse.response.content).toBe('Sunny, 25°C');
	});

	it('converts Anthropic tools to functionDeclarations', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
			tools: [
				{
					name: 'get_time',
					description: 'Get current time',
					input_schema: { type: 'object', properties: {} },
				},
			],
		};
		const result = convertToGemini(body);
		expect(result.tools).toBeDefined();
		expect(result.tools![0].functionDeclarations[0].name).toBe('get_time');
		expect(result.tools![0].functionDeclarations[0].description).toBe('Get current time');
	});

	it('sets generationConfig from max_tokens and temperature', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 512,
			temperature: 0.7,
			messages: [{ role: 'user', content: 'hi' }],
		};
		const result = convertToGemini(body);
		expect(result.generationConfig.maxOutputTokens).toBe(512);
		expect(result.generationConfig.temperature).toBe(0.7);
	});

	it('omits systemInstruction when no system prompt', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
		};
		const result = convertToGemini(body);
		expect(result.systemInstruction).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Schema sanitization — unsupported fields must be stripped
// ---------------------------------------------------------------------------

describe('convertToGemini — schema sanitization', () => {
	it('strips $schema and additionalProperties from tool parameters', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
			tools: [
				{
					name: 'read_file',
					description: 'Read a file',
					input_schema: {
						$schema: 'http://json-schema.org/draft-07/schema#',
						type: 'object',
						additionalProperties: false,
						properties: {
							path: { type: 'string', description: 'File path' },
						},
						required: ['path'],
					},
				},
			],
		};
		const result = convertToGemini(body);
		const params = result.tools![0].functionDeclarations[0].parameters;
		expect(params).not.toHaveProperty('$schema');
		expect(params).not.toHaveProperty('additionalProperties');
		expect(params).toHaveProperty('required');
		// properties should survive
		expect((params as Record<string, unknown>).properties).toBeDefined();
	});

	it('strips propertyNames and converts type to uppercase', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
			tools: [
				{
					name: 'list_dir',
					description: 'List directory',
					input_schema: {
						type: 'object',
						propertyNames: { pattern: '^[a-z]+$' },
						properties: {
							path: { type: 'string' },
						},
					},
				},
			],
		};
		const result = convertToGemini(body);
		const params = result.tools![0].functionDeclarations[0].parameters as Record<string, unknown>;
		expect(params).not.toHaveProperty('propertyNames');
		expect(params.type).toBe('OBJECT');
		const props = params.properties as Record<string, Record<string, unknown>>;
		expect(props.path.type).toBe('STRING');
	});

	it('strips unsupported fields from nested items schemas', () => {
		const body: MessagesRequest = {
			model: 'claude-sonnet-4-6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
			tools: [
				{
					name: 'batch',
					description: 'Batch op',
					input_schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							items: {
								type: 'array',
								items: {
									type: 'object',
									additionalProperties: false,
									properties: {
										id: { type: 'string' },
									},
								},
							},
						},
					},
				},
			],
		};
		const result = convertToGemini(body);
		const params = result.tools![0].functionDeclarations[0].parameters as Record<string, unknown>;
		expect(params).not.toHaveProperty('additionalProperties');
		const props = params.properties as Record<string, Record<string, unknown>>;
		const itemsSchema = props.items as Record<string, unknown>;
		expect(itemsSchema).not.toHaveProperty('additionalProperties');
		const nestedItems = itemsSchema.items as Record<string, unknown>;
		expect(nestedItems).not.toHaveProperty('additionalProperties');
	});
});

// ---------------------------------------------------------------------------
// mapGeminiError — HTTP error mapping
// ---------------------------------------------------------------------------

describe('mapGeminiError — HTTP error mapping', () => {
	it('maps 401 to authentication_error', () => {
		const err = mapGeminiError(401, JSON.stringify({ error: { message: 'API key invalid' } }));
		expect(err.status).toBe(401);
		expect(err.errorType).toBe('authentication_error');
		expect(err.message).toBe('API key invalid');
	});

	it('maps 429 to rate_limit_error', () => {
		const err = mapGeminiError(429, JSON.stringify({ error: { message: 'Quota exceeded' } }));
		expect(err.status).toBe(429);
		expect(err.errorType).toBe('rate_limit_error');
	});

	it('maps 400 to invalid_request_error', () => {
		const err = mapGeminiError(400, JSON.stringify({ error: { message: 'Bad request' } }));
		expect(err.status).toBe(400);
		expect(err.errorType).toBe('invalid_request_error');
	});

	it('maps 403 to permission_error', () => {
		const err = mapGeminiError(403, '');
		expect(err.status).toBe(403);
		expect(err.errorType).toBe('permission_error');
	});

	it('maps 500 to api_error', () => {
		const err = mapGeminiError(500, '');
		expect(err.status).toBe(500);
		expect(err.errorType).toBe('api_error');
	});

	it('falls back gracefully on unparseable body', () => {
		const err = mapGeminiError(429, 'not json');
		expect(err.status).toBe(429);
		expect(err.errorType).toBe('rate_limit_error');
		expect(err.message).toContain('not json');
	});
});
