// Error mapping and proxy error types

export class ProxyError extends Error {
	constructor(
		public readonly status: number,
		public readonly errorType: string,
		message: string,
	) {
		super(message);
		this.name = 'ProxyError';
	}
}

export interface MappedError {
	status: number;
	errorType: string;
	message: string;
}

export function mapHttpError(status: number, body: string): MappedError {
	if (status === 429) {
		return { status: 429, errorType: 'rate_limit_error', message: 'Rate limit exceeded by upstream provider' };
	}
	if (status === 401 || status === 403) {
		return { status, errorType: 'authentication_error', message: `Provider authentication failed (HTTP ${status})` };
	}
	if (status === 503 || status === 529) {
		return { status, errorType: 'overloaded_error', message: 'Provider is currently overloaded' };
	}
	if (status >= 500) {
		return { status, errorType: 'api_error', message: `Provider error ${status}: ${body.slice(0, 200)}` };
	}
	return { status, errorType: 'invalid_request_error', message: body.slice(0, 200) };
}
