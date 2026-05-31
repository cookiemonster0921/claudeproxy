import type { Env } from '../types';
import type { Session } from './sessionStore';
import type { ProjectSettings } from '../projects/projectSettings';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export interface ResolvedSettings {
	model: string;
	effortLevel: EffortLevel;
	systemPromptAddition: string;
	maxTokens: number;
}

const EFFORT_MAX_TOKENS: Record<EffortLevel, number> = {
	low: 512,
	medium: 1024,
	high: 2048,
	xhigh: 4096,
	max: 8192,
	auto: 4096,
};

const EFFORT_SYSTEM_SNIPPETS: Partial<Record<EffortLevel, string>> = {
	low: 'Be concise. Minimal explanation.',
	high: 'Think step by step. Be thorough and detailed.',
	xhigh: 'Think step by step. Be thorough and detailed. Consider edge cases.',
	max: 'Think step by step. Be exhaustive, thorough, and detailed. Cover all edge cases and alternatives.',
};

export function resolveSettings(
	env: Env,
	session: Session | null,
	project: ProjectSettings | null,
	overrides?: { model?: string; effort?: EffortLevel },
): ResolvedSettings {
	const model =
		overrides?.model ??
		session?.modelOverride ??
		project?.defaultModel ??
		env.DEFAULT_MODEL ??
		env.MODEL ??
		'claude-sonnet-4-6';

	const effortLevel: EffortLevel = overrides?.effort ?? session?.effortLevel ?? 'auto';

	const snippets: string[] = [];
	const effortSnippet = EFFORT_SYSTEM_SNIPPETS[effortLevel];
	if (effortSnippet) snippets.push(effortSnippet);
	if (project?.systemPrompt) snippets.push(project.systemPrompt);
	if (session?.goal) snippets.push(`Current goal: ${session.goal}`);
	const systemPromptAddition = snippets.join('\n');

	return {
		model,
		effortLevel,
		systemPromptAddition,
		maxTokens: EFFORT_MAX_TOKENS[effortLevel],
	};
}

export function effortDescription(level: EffortLevel): string {
	const descriptions: Record<EffortLevel, string> = {
		low: 'low (512 tokens, brief)',
		medium: 'medium (1024 tokens)',
		high: 'high (2048 tokens, detailed)',
		xhigh: 'xhigh (4096 tokens, thorough)',
		max: 'max (8192 tokens, exhaustive)',
		auto: 'auto (4096 tokens, default)',
	};
	return descriptions[level];
}
