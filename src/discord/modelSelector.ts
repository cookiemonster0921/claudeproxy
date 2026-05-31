/**
 * Model selector UI — two-step Discord select menu flow:
 *   1. /model  →  provider dropdown
 *   2. pick provider  →  model dropdown for that provider
 *   3. pick model  →  saved, confirmation
 */

import type { DiscordActionRow } from './discordTypes';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ModelOption {
	label: string;
	value: string; // the fully-qualified model string stored in the session
	description?: string;
}

export interface ProviderEntry {
	label: string;
	value: string; // provider key, used in custom_id
	emoji: string;
	description: string;
	models: ModelOption[];
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
	{
		label: 'Anthropic',
		value: 'openrouter_anthropic',
		emoji: '🟣',
		description: 'Claude models via OpenRouter',
		models: [
			{ label: 'Claude Sonnet 4.5', value: 'openrouter/anthropic/claude-sonnet-4-5', description: 'Best balance of speed & intelligence' },
			{ label: 'Claude Opus 4.5',   value: 'openrouter/anthropic/claude-opus-4-5',   description: 'Most powerful Claude model' },
			{ label: 'Claude 3.5 Haiku',  value: 'openrouter/anthropic/claude-3-5-haiku-20241022', description: 'Fastest & cheapest Claude' },
		],
	},
	{
		label: 'Google',
		value: 'google_ai',
		emoji: '🔵',
		description: 'Gemini models via Google AI',
		models: [
			{ label: 'Gemini 2.5 Flash',     value: 'google_ai/gemini-2.5-flash',     description: 'Fast, low cost, strong reasoning' },
			{ label: 'Gemini 2.5 Pro',        value: 'google_ai/gemini-2.5-pro',       description: 'Most capable Gemini model' },
			{ label: 'Gemini 2.0 Flash',      value: 'google_ai/gemini-2.0-flash',     description: 'Previous gen, very fast' },
		],
	},
	{
		label: 'Cloudflare Workers AI',
		value: 'workers_ai',
		emoji: '🟠',
		description: 'Open-source models, free tier',
		models: [
			{ label: 'Llama 3.3 70B',      value: 'cf-llama',      description: 'Meta Llama — general purpose' },
			{ label: 'Qwen 2.5 Coder 32B', value: 'cf-qwen-coder', description: 'Specialised for code' },
		],
	},
	{
		label: 'NVIDIA NIM',
		value: 'nvidia_nim',
		emoji: '🟢',
		description: 'Hosted models on NVIDIA hardware',
		models: [
			{ label: 'Llama 3.3 70B Instruct', value: 'nvidia_nim/meta/llama-3.3-70b-instruct', description: 'High-throughput NVIDIA hosting' },
		],
	},
];

export function findProvider(key: string): ProviderEntry | undefined {
	return PROVIDER_CATALOG.find((p) => p.value === key);
}

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------

/** Step 1 — provider select */
export function buildProviderSelectRow(): DiscordActionRow {
	return {
		type: 1,
		components: [
			{
				type: 3 as unknown as 2,          // StringSelect — cast since DiscordButton type is 2
				custom_id: 'model_provider_select',
				placeholder: 'Choose a provider…',
				options: PROVIDER_CATALOG.map((p) => ({
					label: p.label,
					value: p.value,
					description: p.description,
					emoji: { name: p.emoji },
				})),
			} as unknown as import('./discordTypes').DiscordButton,
		],
	};
}

/** Step 2 — model select for a given provider key */
export function buildModelSelectRow(providerKey: string): DiscordActionRow | null {
	const provider = findProvider(providerKey);
	if (!provider) return null;
	return {
		type: 1,
		components: [
			{
				type: 3 as unknown as 2,
				custom_id: `model_model_select:${providerKey}`,
				placeholder: `Choose a ${provider.label} model…`,
				options: provider.models.map((m) => ({
					label: m.label,
					value: m.value,
					description: m.description,
				})),
			} as unknown as import('./discordTypes').DiscordButton,
		],
	};
}

/** A "go back" button so the user can switch provider */
export function buildBackRow(): DiscordActionRow {
	return {
		type: 1,
		components: [
			{
				type: 2 as const,
				style: 2,
				label: '← Back to providers',
				custom_id: 'model_back',
				emoji: { name: '↩️' },
			},
		],
	};
}
