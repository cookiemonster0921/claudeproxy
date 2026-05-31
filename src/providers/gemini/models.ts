// Gemini model identifiers and context window sizes

export const GEMINI_MODEL_MAP: Record<string, string> = {
	'gemini-3.5-flash': 'gemini-3.5-flash',
	'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite',
	'gemini-3-flash-preview': 'gemini-3-flash-preview',
	'gemini-2.5-pro': 'gemini-2.5-pro',
	'gemini-2.5-flash': 'gemini-2.5-flash',
	'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
	'gemini-2.0-flash': 'gemini-2.0-flash',
};

// Aliases used so handleModels() can surface these in /v1/models
export const GEMINI_MODEL_ALIASES: Record<string, string> = {
	'gemini-3.5-flash': 'google_ai/gemini-3.5-flash',
	'gemini-3.1-flash-lite': 'google_ai/gemini-3.1-flash-lite',
	'gemini-3-flash-preview': 'google_ai/gemini-3-flash-preview',
	'gemini-2.5-pro': 'google_ai/gemini-2.5-pro',
	'gemini-2.5-flash': 'google_ai/gemini-2.5-flash',
	'gemini-2.5-flash-lite': 'google_ai/gemini-2.5-flash-lite',
	'gemini-2.0-flash': 'google_ai/gemini-2.0-flash',
};

// Context windows in tokens. Gemini 2.x/3.x support 1M+ input tokens.
export const GEMINI_CONTEXT_WINDOWS: Record<string, number> = {
	'gemini-3.5-flash': 1_048_576,
	'gemini-3.1-flash-lite': 1_048_576,
	'gemini-3-flash-preview': 1_048_576,
	'gemini-2.5-pro': 1_048_576,
	'gemini-2.5-flash': 1_048_576,
	'gemini-2.5-flash-lite': 1_048_576,
	'gemini-2.0-flash': 1_048_576,
};

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
