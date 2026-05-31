// Map Gemini HTTP errors to Anthropic error format

export interface MappedError {
	status: number;
	errorType: string;
	message: string;
}

export function mapGeminiError(status: number, body: string): MappedError {
	let detail = '';
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } };
		detail = parsed?.error?.message ?? '';
	} catch {
		detail = body.slice(0, 200);
	}

	const msg = detail || `Gemini API error (HTTP ${status})`;

	switch (status) {
		case 400:
			return { status: 400, errorType: 'invalid_request_error', message: msg };
		case 401:
			return { status: 401, errorType: 'authentication_error', message: msg };
		case 403:
			return { status: 403, errorType: 'permission_error', message: msg };
		case 404:
			return { status: 404, errorType: 'not_found_error', message: msg };
		case 429:
			return { status: 429, errorType: 'rate_limit_error', message: msg };
		case 500:
		case 503:
			return { status: status, errorType: 'api_error', message: msg };
		default:
			return { status: status >= 500 ? status : 500, errorType: 'api_error', message: msg };
	}
}
