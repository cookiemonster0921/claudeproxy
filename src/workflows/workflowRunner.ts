import type { Env, MessagesRequest, AnthropicAssistantResponse, TextContentBlock, AnthropicMessage } from '../types';
import { ProxyService } from '../proxy-service';
import { loadSettings } from '../config';
import type { EffortLevel } from '../sessions/settingsResolver';

export interface WorkflowStep {
	systemPrompt: string;
	userPrompt: string;
	label: string;
}

export interface WorkflowResult {
	output: string;
	stepCount: number;
	durationMs: number;
}

async function runStep(
	env: Env,
	systemPrompt: string,
	messages: AnthropicMessage[],
	model: string,
	maxTokens: number,
): Promise<string> {
	const settings = loadSettings(env);
	const service = new ProxyService(settings, env);
	const body: MessagesRequest = {
		model,
		max_tokens: maxTokens,
		messages,
		...(systemPrompt ? { system: systemPrompt } : {}),
		stream: false,
	};
	const response = await service.handleMessages(body, crypto.randomUUID());
	const data = (await response.json()) as AnthropicAssistantResponse;
	const textBlock = data.content.find((b) => b.type === 'text') as TextContentBlock | undefined;
	return textBlock?.text ?? '';
}

export async function runWorkflow(
	env: Env,
	steps: WorkflowStep[],
	model: string,
	maxTokens: number,
): Promise<WorkflowResult> {
	const start = Date.now();
	let lastOutput = '';

	for (const step of steps) {
		const messages: AnthropicMessage[] =
			lastOutput
				? [
						{ role: 'user', content: step.userPrompt },
						{ role: 'assistant', content: lastOutput },
						{ role: 'user', content: 'Continue with the next step.' },
					]
				: [{ role: 'user', content: step.userPrompt }];

		lastOutput = await runStep(env, step.systemPrompt, messages, model, maxTokens);
	}

	return { output: lastOutput, stepCount: steps.length, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Workflow factories
// ---------------------------------------------------------------------------

export function planWorkflow(description: string): WorkflowStep[] {
	return [
		{
			label: 'Plan',
			systemPrompt: 'You are a senior software architect. Create clear, actionable implementation plans.',
			userPrompt: `Create a detailed implementation plan for the following:\n\n${description}\n\nInclude: overview, steps, files to change, risks, and verification approach.`,
		},
	];
}

export function reviewWorkflow(target: string, effort: EffortLevel): WorkflowStep[] {
	const depth = effort === 'low' ? 'high-level' : effort === 'max' ? 'exhaustive' : 'thorough';
	return [
		{
			label: 'Review',
			systemPrompt: `You are a ${depth} code reviewer. Identify issues, improvements, and patterns.`,
			userPrompt: `Perform a ${depth} review of the following:\n\n${target || '(the current session context)'}\n\nCover: correctness, maintainability, performance, security, and style.`,
		},
	];
}

export function codeReviewWorkflow(target: string): WorkflowStep[] {
	return [
		{
			label: 'Code Review',
			systemPrompt:
				'You are an expert code reviewer. Be specific, cite line numbers or patterns when possible, and suggest concrete improvements.',
			userPrompt: `Perform a structured code review of:\n\n${target}\n\nOrganize your review into: Critical Issues, Bugs, Style/Maintainability, Performance, and Suggestions.`,
		},
	];
}

export function securityReviewWorkflow(target: string): WorkflowStep[] {
	return [
		{
			label: 'Security Review',
			systemPrompt:
				'You are a security engineer specializing in application security. Focus on vulnerabilities, attack vectors, and mitigations.',
			userPrompt: `Perform a security-focused review of:\n\n${target}\n\nCheck for: injection attacks, auth/authz issues, secrets exposure, insecure dependencies, input validation, CORS/CSP, and other OWASP Top 10 concerns.`,
		},
	];
}

export function qaWorkflow(sessionSummary: string): WorkflowStep[] {
	return [
		{
			label: 'QA',
			systemPrompt:
				'You are a QA engineer. Identify gaps, untested assumptions, and potential failure modes.',
			userPrompt: `Review the following session/code and identify:\n\n${sessionSummary}\n\nList: unverified assumptions, potential bugs, missing test cases, edge cases, and integration risks.`,
		},
	];
}

export function recapWorkflow(history: string): WorkflowStep[] {
	return [
		{
			label: 'Recap',
			systemPrompt: 'Summarize concisely.',
			userPrompt: `Summarize this conversation in 3–5 bullet points. Focus on decisions made, code written, and next steps:\n\n${history}`,
		},
	];
}

export function compactWorkflow(history: string, instructions?: string): WorkflowStep[] {
	const extra = instructions ? `\n\nAdditional instructions: ${instructions}` : '';
	return [
		{
			label: 'Compact',
			systemPrompt: 'Create a dense, information-rich summary suitable for continuing a conversation.',
			userPrompt: `Compact this conversation into a concise context summary that preserves all important decisions, code, and context needed to continue working:${extra}\n\n${history}`,
		},
	];
}
