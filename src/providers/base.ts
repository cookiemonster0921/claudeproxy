import type { MessagesRequest } from '../types';
import type { RoutedRequest } from '../model-router';

export interface ProviderConfig {
	apiKey: string | undefined;
	baseUrl: string;
	readTimeoutMs: number;
	logRawPayloads: boolean;
	logErrorTracebacks: boolean;
}

export interface BaseProvider {
	/** Validate the request before streaming begins. Throw ProxyError to abort cleanly. */
	preflight(body: MessagesRequest): void;
	/** Yield complete Anthropic SSE event strings (full envelope from message_start to message_stop). */
	streamResponse(routed: RoutedRequest, inputTokens: number, requestId: string): AsyncIterable<string>;
	cleanup(): Promise<void>;
}
