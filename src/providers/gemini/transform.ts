// Anthropic MessagesRequest → Gemini GenerateContentRequest conversion

import type { MessagesRequest, AnthropicMessage, AnthropicTool, TextContentBlock } from '../../types';
import { stringifySystem } from '../../types';

// ---------------------------------------------------------------------------
// Gemini request types
// ---------------------------------------------------------------------------

export interface GeminiTextPart {
	text: string;
	thought?: boolean;
}

export interface GeminiThoughtPart {
	text: string;
	thought: true;
}

export interface GeminiFunctionCallPart {
	functionCall: {
		name: string;
		args: Record<string, unknown>;
		thought_signature?: string;
	};
}

export interface GeminiFunctionResponsePart {
	functionResponse: {
		name: string;
		response: { content: string };
	};
}

export type GeminiPart = GeminiTextPart | GeminiThoughtPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

export interface GeminiContent {
	role: 'user' | 'model';
	parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface GeminiRequest {
	contents: GeminiContent[];
	systemInstruction?: { parts: [{ text: string }] };
	tools?: [{ functionDeclarations: GeminiFunctionDeclaration[] }];
	generationConfig: {
		maxOutputTokens: number;
		temperature?: number;
	};
}

// ---------------------------------------------------------------------------
// Schema sanitization — Gemini only supports a strict subset of JSON Schema.
// Fields like $schema, additionalProperties, propertyNames, allOf, oneOf, not
// cause a 400 error. Strip them recursively before sending to the API.
// Ref: https://ai.google.dev/api/caching#Schema
// ---------------------------------------------------------------------------

// Fields that Gemini's Schema type does NOT support
const UNSUPPORTED_SCHEMA_FIELDS = new Set([
	'$schema',
	'$id',
	'$ref',
	'$defs',
	'definitions',
	'additionalProperties',
	'additionalItems',
	'propertyNames',
	'patternProperties',
	'contains',
	'allOf',
	'oneOf',
	'not',
	'if',
	'then',
	'else',
	'unevaluatedProperties',
	'unevaluatedItems',
	'const',
	'readOnly',
	'writeOnly',
	'discriminator',
	'externalDocs',
	'xml',
	// JSON Schema draft-7 exclusive range keywords (Gemini uses minimum/maximum only)
	'exclusiveMinimum',
	'exclusiveMaximum',
	// Other common unsupported fields
	'dependencies',
	'prefixItems',
]);

/** Pick a single Gemini-compatible type from a JSON Schema type value.
 *  JSON Schema allows `type: "string"` or `type: ["string", "null"]`.
 *  Gemini only accepts a single uppercase string (STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT).
 */
function resolveType(value: unknown): string | undefined {
	if (typeof value === 'string') return value.toUpperCase();
	if (Array.isArray(value)) {
		// Pick the first non-"null" entry, fall back to first entry
		const nonNull = (value as string[]).find((t) => t !== 'null');
		const chosen = nonNull ?? (value as string[])[0];
		return typeof chosen === 'string' ? chosen.toUpperCase() : undefined;
	}
	return undefined;
}

function sanitizeSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;

	const src = schema as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(src)) {
		// Skip known unsupported fields
		if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;
		// Strip all OpenAPI vendor extensions (x-go-type, x-go-name, x-examples, etc.)
		if (key.startsWith('x-')) continue;

		if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
			// Recurse into each property schema
			const sanitizedProps: Record<string, unknown> = {};
			for (const [propKey, propSchema] of Object.entries(value as Record<string, unknown>)) {
				sanitizedProps[propKey] = sanitizeSchema(propSchema);
			}
			out[key] = sanitizedProps;
		} else if (key === 'items') {
			// JSON Schema allows items as an array (tuple validation) — Gemini requires a single schema
			const itemsSchema = Array.isArray(value) ? value[0] : value;
			out[key] = sanitizeSchema(itemsSchema);
		} else if (key === 'anyOf' && Array.isArray(value)) {
			// anyOf IS supported by Gemini — sanitize each sub-schema
			out[key] = value.map(sanitizeSchema);
		} else if (key === 'type') {
			// Gemini requires a single uppercase type string; JSON Schema allows arrays
			const resolved = resolveType(value);
			if (resolved) out[key] = resolved;
		} else if (key === 'enum' && Array.isArray(value)) {
			// Gemini only supports string enum values — coerce numbers/booleans to strings
			out[key] = value.map((v) => (typeof v === 'string' ? v : String(v)));
		} else {
			out[key] = value;
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function toolResultText(content: string | TextContentBlock[]): string {
	return typeof content === 'string' ? content : content.map((b) => b.text).join('\n');
}

/**
 * Scan all messages and build a map of tool_use_id → function_name.
 *
 * Gemini's functionResponse.name must match the declared function name (e.g. "WebSearch"),
 * NOT the Anthropic tool call ID (e.g. "toolu_abc123"). Since tool_result blocks only carry
 * the tool_use_id, we pre-scan the conversation to recover the original name mapping.
 */
function buildToolIdMap(messages: AnthropicMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const msg of messages) {
		if (typeof msg.content === 'string') continue;
		for (const block of msg.content) {
			if (block.type === 'tool_use') {
				map.set(block.id, block.name);
			}
		}
	}
	return map;
}

function convertMessage(msg: AnthropicMessage, toolIdMap: Map<string, string>): GeminiContent {
	// Anthropic 'assistant' → Gemini 'model'
	const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

	if (typeof msg.content === 'string') {
		return { role, parts: [{ text: msg.content }] };
	}

	const parts: GeminiPart[] = [];
	let pendingThoughtSignature: string | undefined;
	for (const block of msg.content) {
		switch (block.type) {
			case 'thinking': {
				// Carry the thinking text as a thought part and stash the signature
				// so it can be attached to the immediately following tool_use block.
				const tb = block as { type: 'thinking'; thinking: string; signature?: string };
				if (tb.thinking) parts.push({ text: tb.thinking, thought: true });
				if (tb.signature) pendingThoughtSignature = tb.signature;
				break;
			}
			case 'text':
				parts.push({ text: (block as TextContentBlock).text });
				break;
			case 'image':
				parts.push({ text: '[image content not supported]' });
				break;
			case 'tool_use': {
				const fcPart: GeminiFunctionCallPart = {
					functionCall: {
						name: block.name,
						args: block.input as Record<string, unknown>,
					},
				};
				if (pendingThoughtSignature) {
					fcPart.functionCall.thought_signature = pendingThoughtSignature;
					pendingThoughtSignature = undefined;
				}
				parts.push(fcPart);
				break;
			}
			case 'tool_result': {
				const text = toolResultText(block.content);
				// Gemini requires the function name in functionResponse.name (e.g. "WebSearch"),
				// not the tool call ID (e.g. "toolu_abc123"). Look it up from the pre-built map.
				const fnName = toolIdMap.get(block.tool_use_id) ?? block.tool_use_id;
				parts.push({
					functionResponse: {
						name: fnName,
						response: { content: text },
					},
				});
				break;
			}
		}
	}

	// Gemini requires at least one part; guard against empty content arrays.
	if (parts.length === 0) {
		parts.push({ text: '' });
	}

	return { role, parts };
}

function convertTools(tools: AnthropicTool[]): [{ functionDeclarations: GeminiFunctionDeclaration[] }] | undefined {
	if (!tools.length) return undefined;
	const decls = tools
		.filter((t) => typeof t.name === 'string' && t.name.length > 0)
		.map((t) => ({
			name: t.name,
			description: t.description ?? '',
			// Sanitize the input_schema — Gemini rejects $schema, additionalProperties,
			// propertyNames, allOf, oneOf, not, and other unsupported JSON Schema fields.
			parameters: (sanitizeSchema(t.input_schema ?? { type: 'object', properties: {} }) as Record<string, unknown>),
		}));
	return decls.length > 0 ? [{ functionDeclarations: decls }] : undefined;
}

// ---------------------------------------------------------------------------
// Main conversion function
// ---------------------------------------------------------------------------

export function convertToGemini(body: MessagesRequest): GeminiRequest {
	// Pre-scan messages to map tool_use_id → function_name for tool_result conversion
	const toolIdMap = buildToolIdMap(body.messages);

	const req: GeminiRequest = {
		contents: body.messages.map((msg) => convertMessage(msg, toolIdMap)),
		generationConfig: {
			maxOutputTokens: body.max_tokens,
		},
	};

	const systemText = stringifySystem(body.system);
	if (systemText) {
		req.systemInstruction = { parts: [{ text: systemText }] };
	}

	if (typeof body.temperature === 'number') {
		req.generationConfig.temperature = body.temperature;
	}

	if (body.tools?.length) {
		const tools = convertTools(body.tools);
		if (tools) req.tools = tools;
	}

	return req;
}
