import type {
	Env,
	MessagesRequest,
	AnthropicAssistantResponse,
	TextContentBlock,
	AnthropicMessage,
} from '../types';
import { ProxyService } from '../proxy-service';
import { loadSettings } from '../config';
import { logAnalytics, estimateCostUsd } from '../analytics';
import { querySummary } from '../analytics';
import type { DiscordInteraction, DiscordOption, EffortLevel } from './discordTypes';
import { getSession, upsertSession, setGoal, setStatus, incrementMessageCount } from '../sessions/sessionStore';
import { addMessage, getHistory, clearHistory, countMessages, exportHistory } from '../sessions/conversationStore';
import { resolveSettings, effortDescription } from '../sessions/settingsResolver';
import { getProject } from '../projects/projectSettings';
import { storeMessagesEnabled } from './permissions';
import {
	runWorkflow,
	planWorkflow,
	reviewWorkflow,
	codeReviewWorkflow,
	securityReviewWorkflow,
	qaWorkflow,
	recapWorkflow,
	compactWorkflow,
} from '../workflows/workflowRunner';

// ---------------------------------------------------------------------------
// Internal Claude call — goes through ProxyService, no HTTP round-trip
// ---------------------------------------------------------------------------

interface ClaudeResult {
	text: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
	provider: string;
}

async function callClaude(
	env: Env,
	model: string,
	maxTokens: number,
	messages: AnthropicMessage[],
	system?: string,
): Promise<ClaudeResult> {
	const settings = loadSettings(env);
	const service = new ProxyService(settings, env);
	const body: MessagesRequest = {
		model,
		max_tokens: maxTokens,
		messages,
		...(system ? { system } : {}),
		stream: false,
	};
	const start = Date.now();
	const response = await service.handleMessages(body, crypto.randomUUID());
	const durationMs = Date.now() - start;
	const data = (await response.json()) as AnthropicAssistantResponse;

	// Check for error response from provider
	const errorData = data as unknown as { error?: { message?: string; type?: string } };
	if (errorData.error) {
		const errMsg = errorData.error.message ?? errorData.error.type ?? 'Provider error';
		console.error('[callClaude] provider error:', errMsg);
		throw new Error(`Provider error: ${errMsg}`);
	}

	const textBlock = data.content?.find((b) => b.type === 'text') as TextContentBlock | undefined;
	// Use || not ?? — catches empty string responses (e.g. Workers AI returning "")
	const text = textBlock?.text || '*(no response)*';
	return {
		text,
		durationMs,
		inputTokens: data.usage?.input_tokens ?? 0,
		outputTokens: data.usage?.output_tokens ?? 0,
		model: data.model ?? model,
		provider: '',
	};
}

async function logDiscordAnalytics(
	db: D1Database,
	_env: Env,
	interaction: DiscordInteraction,
	commandName: string,
	result: ClaudeResult,
	success: boolean,
): Promise<void> {
	try {
		const provider = result.provider || 'unknown';
		await logAnalytics(db, {
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			method: 'DISCORD',
			path: `/${commandName}`,
			model: result.model,
			provider,
			stream: false,
			status_code: success ? 200 : 500,
			success,
			duration_ms: result.durationMs,
			approximate_input_tokens: result.inputTokens,
			approximate_output_tokens: result.outputTokens,
			estimated_cost_usd: estimateCostUsd(provider, result.model, result.inputTokens, result.outputTokens),
			estimated_context_tokens: result.inputTokens,
			estimated_prompt_tokens: result.inputTokens,
			estimated_tool_result_tokens: 0,
			billable_input_tokens: result.inputTokens,
			billable_output_tokens: result.outputTokens,
			cached_input_tokens: 0,
			failed_request_tokens: success ? 0 : result.inputTokens,
			request_kind: success ? 'normal' : 'failed',
			was_retry: false,
			retry_count: 0,
			provider_usage_json: JSON.stringify({
				input_tokens: result.inputTokens,
				output_tokens: result.outputTokens,
			}),
			error_type: success ? undefined : 'discord_error',
			fallback_used: false,
			user_agent: 'discord-bot',
			client_ip_hash: undefined,
			prompt_snapshot: undefined,
			response_snapshot: result.text.slice(0, 200),
			tool_snapshot: undefined,
			source: 'discord',
			discord_guild_id: interaction.guild_id,
			discord_channel_id: interaction.channel_id,
			discord_command: commandName,
		});
	} catch {
		// analytics must never break user requests
	}
}

// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------

function opt(options: DiscordOption[], name: string): string | undefined {
	const o = options.find((x) => x.name === name);
	return o?.value != null ? String(o.value) : undefined;
}

// ---------------------------------------------------------------------------
// Core — no AI call
// ---------------------------------------------------------------------------

export async function handleStatus(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const [session, msgCount] = await Promise.all([
		getSession(db, channelId),
		countMessages(db, channelId),
	]);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);

	const lines = ['**Session Status**'];
	lines.push(`Status: ${session?.status ?? 'no session'}`);
	lines.push(`Model: \`${settings.model}\``);
	lines.push(`Effort: ${effortDescription(settings.effortLevel)}`);
	if (session?.goal) lines.push(`Goal: ${session.goal}`);
	if (session?.projectName) lines.push(`Project: \`${session.projectName}\``);
	if (project?.repoUrl) lines.push(`Repo: ${project.repoUrl}`);
	lines.push(`Messages in history: ${msgCount}`);
	lines.push(`Proxy: ✅ online`);
	return lines.join('\n');
}

/** Sentinel value returned by handleModel to signal "show selector UI, not plain text" */
export const MODEL_SELECTOR_SENTINEL = '__MODEL_SELECTOR__';

export async function handleModel(
	_interaction: DiscordInteraction,
	_options: DiscordOption[],
	_db: D1Database,
): Promise<string> {
	// Return a sentinel — interactions.ts will intercept this and send the
	// provider selector as a Discord component instead of plain text.
	return MODEL_SELECTOR_SENTINEL;
}

/** Called after the user picks a model from the dropdown. */
export async function setModelFromSelector(
	db: D1Database,
	channelId: string,
	guildId: string | undefined,
	modelValue: string,
): Promise<string> {
	await upsertSession(db, { channelId, guildId, modelOverride: modelValue });
	return modelValue;
}

export async function handleEffort(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const level = opt(options, 'level') as EffortLevel | undefined;
	if (!level) return '❌ Please provide an effort level.';
	const valid: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
	if (!valid.includes(level)) return `❌ Invalid effort level. Choose: ${valid.join(', ')}`;
	await upsertSession(db, { channelId, guildId: interaction.guild_id, effortLevel: level });
	return `✅ Effort set to ${effortDescription(level)} for this channel.`;
}

export async function handleContext(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const [session, msgCount, history] = await Promise.all([
		getSession(db, channelId),
		countMessages(db, channelId),
		getHistory(db, channelId, 20),
	]);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const approxChars = history.reduce((sum, m) => sum + m.content.length, 0);
	const approxTokens = Math.ceil(approxChars / 4);

	return [
		'**Context Usage**',
		`Messages in history: ${msgCount}`,
		`Approx tokens (last 20 msgs): ~${approxTokens.toLocaleString()}`,
		`Max tokens for next response: ${settings.maxTokens.toLocaleString()}`,
		`Effort level: ${effortDescription(settings.effortLevel)}`,
		`Model: \`${settings.model}\``,
	].join('\n');
}

export async function handleGoal(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const goal = opt(options, 'text');
	if (!goal) return '❌ Please provide a goal description.';
	await setGoal(db, channelId, goal);
	return `✅ Goal set: *${goal}*\n\nThis will be included in the system prompt for future /ask commands.`;
}

export async function handleHelp(): Promise<string> {
	return [
		'**Claude Proxy — Discord Commands**',
		'',
		'**Core**',
		'`/ask <message>` — Chat with Claude (maintains history)',
		'`/status` — Session info, model, effort, goal',
		'`/model <model>` — Set model for this channel',
		'`/effort <level>` — Set effort: low/medium/high/xhigh/max/auto',
		'`/context` — Show token usage and history stats',
		'`/goal <text>` — Set a long-running objective',
		'`/compact [instructions]` — Summarize and compact conversation',
		'`/plan <description>` — Generate an implementation plan',
		'`/review [target]` — Code/architecture review',
		'`/code-review <target>` — Structured code review',
		'`/security-review <target>` — Security-focused review',
		'`/recap` — Summarize this session in bullet points',
		'`/export [format]` — Export transcript (txt or md)',
		'`/qa` — Run QA analysis on session',
		'`/verify <claim>` — Verify a specific claim',
		'`/loop <prompt> [max] [interval]` — Repeated workflow',
		'`/insights` — Analytics dashboard',
		'`/help` — Show this message',
		'',
		'**Admin** *(role-restricted)*',
		'`/agents` `/mcp` `/memory` `/debug` `/batch` `/run` `/updateconfig` `/team-onboarding` and more',
		'',
		'**Buttons** (appear after /ask responses)',
		'▶️ Continue · 🔄 Retry · 💪 Stronger · ℹ️ Status · 📝 Recap',
	].join('\n');
}

export async function handleExport(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const format = (opt(options, 'format') ?? 'md') as 'txt' | 'md';
	const history = await getHistory(db, channelId, 200);
	if (!history.length) return '📭 No message history to export. Start a conversation with `/ask`.';
	const content = exportHistory(history, format);
	if (content.length <= 1900) return `\`\`\`\n${content.slice(0, 1900)}\n\`\`\``;
	// Discord doesn't support file attachments via webhooks easily — truncate with note
	return `📄 **Export** (${history.length} messages, truncated to fit Discord)\n\`\`\`\n${content.slice(0, 1800)}\n…*(${content.length - 1800} chars truncated)*\`\`\``;
}

// ---------------------------------------------------------------------------
// Core — AI calls
// ---------------------------------------------------------------------------

export async function handleAsk(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const prompt = opt(options, 'message');
	if (!prompt) return '❌ Missing message.';

	await upsertSession(db, { channelId, guildId: interaction.guild_id });
	const [session, history] = await Promise.all([
		getSession(db, channelId),
		getHistory(db, channelId, 20),
	]);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);

	const messages: AnthropicMessage[] = [
		...history.map((m) => ({ role: m.role, content: m.content })),
		{ role: 'user', content: prompt },
	];

	const result = await callClaude(env, settings.model, settings.maxTokens, messages, settings.systemPromptAddition || undefined);
	const storeMsg = storeMessagesEnabled(env);
	const ts = new Date().toISOString();
	await Promise.all([
		addMessage(db, channelId, { role: 'user', content: prompt, timestamp: ts }, storeMsg),
		addMessage(db, channelId, { role: 'assistant', content: result.text, timestamp: ts }, storeMsg),
		incrementMessageCount(db, channelId),
		logDiscordAnalytics(db, env, interaction, 'ask', result, true),
	]);

	return `**Claude** (\`${settings.model}\`, ${result.durationMs}ms)\n\n${result.text}`;
}

export async function handleCompact(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const instructions = opt(options, 'instructions');
	const history = await getHistory(db, channelId, 50);
	if (!history.length) return '📭 No conversation to compact.';

	const historyText = history.map((m) => `${m.role}: ${m.content}`).join('\n\n');
	const session = await getSession(db, channelId);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);

	const steps = compactWorkflow(historyText, instructions);
	const workflowResult = await runWorkflow(env, steps, settings.model, 2048);

	const storeMsg = storeMessagesEnabled(env);
	const ts = new Date().toISOString();
	await clearHistory(db, channelId);
	await addMessage(db, channelId, { role: 'assistant', content: `[Compacted summary]\n${workflowResult.output}`, timestamp: ts }, storeMsg);

	return `🗜️ **Compacted** — history replaced with summary.\n\n${workflowResult.output}`;
}

export async function handlePlan(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const description = opt(options, 'description') ?? '';
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const steps = planWorkflow(description || 'the current task');
	const result = await runWorkflow(env, steps, settings.model, settings.maxTokens);
	await logDiscordAnalytics(db, env, interaction, 'plan', { text: result.output, ...result, inputTokens: 0, outputTokens: 0, model: settings.model, provider: '' }, true);
	return `📋 **Plan**\n\n${result.output}`;
}

export async function handleReview(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const target = opt(options, 'target') ?? '';
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const steps = reviewWorkflow(target, settings.effortLevel);
	const result = await runWorkflow(env, steps, settings.model, settings.maxTokens);
	await logDiscordAnalytics(db, env, interaction, 'review', { text: result.output, ...result, inputTokens: 0, outputTokens: 0, model: settings.model, provider: '' }, true);
	return `🔍 **Review**\n\n${result.output}`;
}

export async function handleCodeReview(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const target = opt(options, 'target') ?? '';
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const steps = codeReviewWorkflow(target);
	const result = await runWorkflow(env, steps, settings.model, settings.maxTokens);
	await logDiscordAnalytics(db, env, interaction, 'code-review', { text: result.output, ...result, inputTokens: 0, outputTokens: 0, model: settings.model, provider: '' }, true);
	return `💻 **Code Review**\n\n${result.output}`;
}

export async function handleSecurityReview(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const target = opt(options, 'target') ?? '';
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const steps = securityReviewWorkflow(target);
	const result = await runWorkflow(env, steps, settings.model, settings.maxTokens);
	await logDiscordAnalytics(db, env, interaction, 'security-review', { text: result.output, ...result, inputTokens: 0, outputTokens: 0, model: settings.model, provider: '' }, true);
	return `🔒 **Security Review**\n\n${result.output}`;
}

export async function handleRecap(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const history = await getHistory(db, channelId, 30);
	if (!history.length) return '📭 No conversation history to recap.';
	const historyText = history.map((m) => `${m.role}: ${m.content}`).join('\n\n');
	const session = await getSession(db, channelId);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const steps = recapWorkflow(historyText);
	const result = await runWorkflow(env, steps, settings.model, 512);
	return `📝 **Recap**\n\n${result.output}`;
}

export async function handleQa(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const history = await getHistory(db, channelId, 30);
	const session = await getSession(db, channelId);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const summary = history.length
		? history.map((m) => `${m.role}: ${m.content}`).join('\n\n')
		: '(no conversation history — QA against session context)';
	const steps = qaWorkflow(summary);
	const result = await runWorkflow(env, steps, settings.model, settings.maxTokens);
	await logDiscordAnalytics(db, env, interaction, 'qa', { text: result.output, ...result, inputTokens: 0, outputTokens: 0, model: settings.model, provider: '' }, true);
	return `🧪 **QA Analysis**\n\n${result.output}`;
}

export async function handleVerify(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const claim = opt(options, 'claim') ?? '';
	if (!claim) return '❌ Please provide a claim to verify.';
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const result = await callClaude(
		env,
		settings.model,
		1024,
		[{ role: 'user', content: `Please verify the following claim and explain whether it is correct, partially correct, or incorrect:\n\n"${claim}"\n\nProvide evidence and reasoning.` }],
	);
	return `✅ **Verify**\n\n${result.text}`;
}

export async function handleInsights(
	_interaction: DiscordInteraction,
	_env: Env,
	db: D1Database,
): Promise<string> {
	try {
		const summary = await querySummary(db);
		const discordRows = await db
			.prepare(`SELECT COUNT(*) AS cnt, discord_command, discord_guild_id FROM request_logs WHERE source = 'discord' GROUP BY discord_command ORDER BY cnt DESC LIMIT 10`)
			.all();

		const lines = [
			'**📊 Proxy Analytics**',
			`AI Requests: ${summary.total_requests.toLocaleString()}`,
			`Success Rate: ${summary.total_requests === 0 ? 'N/A' : ((summary.successful_requests / summary.total_requests) * 100).toFixed(1) + '%'}`,
			`Est. Cost: $${Number(summary.total_estimated_cost_usd).toFixed(4)}`,
			`Avg Latency: ${Math.round(summary.avg_duration_ms)}ms`,
			`Total Tokens: ${(summary.total_input_tokens + summary.total_output_tokens).toLocaleString()}`,
		];

		if (summary.by_model.length) {
			lines.push('', '**By Model:**');
			for (const m of summary.by_model.slice(0, 5)) {
				lines.push(`• \`${m.key}\` — ${m.count} requests`);
			}
		}

		const dcRows = discordRows.results ?? [];
		if (dcRows.length) {
			lines.push('', '**Discord Commands:**');
			for (const r of dcRows.slice(0, 5)) {
				const row = r as Record<string, unknown>;
				lines.push(`• \`/${row.discord_command ?? '?'}\` — ${row.cnt} uses`);
			}
		}

		return lines.join('\n');
	} catch (err) {
		return `⚠️ Analytics unavailable: ${err instanceof Error ? err.message : String(err)}`;
	}
}

export async function handleLoop(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const prompt = opt(options, 'prompt') ?? '';
	if (!prompt) return '❌ Please provide a prompt for the loop.';
	const maxIter = Math.min(parseInt(opt(options, 'max_iterations') ?? '3', 10), 10);
	const session = await getSession(db, channelId);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);

	await setStatus(db, channelId, 'active');
	const results: string[] = [];

	for (let i = 1; i <= maxIter; i++) {
		const current = await getSession(db, channelId);
		if (current?.status === 'stopped') {
			results.push(`⏹️ Loop stopped at iteration ${i - 1}.`);
			break;
		}
		const result = await callClaude(
			env,
			settings.model,
			settings.maxTokens,
			[{ role: 'user', content: `Iteration ${i}/${maxIter}: ${prompt}` }],
			settings.systemPromptAddition || undefined,
		);
		results.push(`**Iteration ${i}:** ${result.text.slice(0, 300)}${result.text.length > 300 ? '…' : ''}`);
	}

	return `🔁 **Loop** (${maxIter} iterations)\n\n${results.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Admin commands
// ---------------------------------------------------------------------------

export async function handleAgents(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const lines = [
		'**🤖 Agent / Provider Info**',
		`Active model: \`${settings.model}\``,
		`Effort level: ${effortDescription(settings.effortLevel)}`,
		`Workers AI: ${env.AI ? '✅' : '❌'}`,
		`OpenRouter: ${env.OPENROUTER_API_KEY ? '✅' : '❌'}`,
		`NVIDIA NIM: ${env.NVIDIA_NIM_API_KEY ? '✅' : '❌'}`,
		`Cloudflare REST: ${env.CLOUDFLARE_API_TOKEN ? '✅' : '❌'}`,
		`DeepSeek: ${env.DEEPSEEK_API_KEY ? '✅' : '❌'}`,
	];
	return lines.join('\n');
}

export async function handleMcp(_env: Env): Promise<string> {
	return [
		'**🔌 MCP Configuration**',
		'No MCP servers are configured at the proxy level.',
		'MCP runs locally in the Claude Code client.',
		'Use the Claude Code CLI to manage MCP: `claude mcp add <server>`',
	].join('\n');
}

export async function handleMemory(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const [msgCount, session] = await Promise.all([
		countMessages(db, channelId),
		getSession(db, channelId),
	]);
	return [
		'**🧠 Memory / Storage**',
		`Messages in this channel: ${msgCount}`,
		`Session message_count counter: ${session?.messageCount ?? 0}`,
		`Message storage: ${env.DISCORD_STORE_MESSAGES === 'true' ? '✅ full content' : '🔒 privacy mode (no content)'}`,
		`D1 DB: ${env.DB ? '✅ connected' : '❌ not configured'}`,
	].join('\n');
}

export async function handleBatch(
	_interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	_db: D1Database,
): Promise<string> {
	const prompt = opt(options, 'prompt') ?? '';
	if (!prompt) return '❌ Please provide a prompt.';
	const models = ['claude-sonnet-4-6', 'claude-haiku-4-5'];
	const results = await Promise.allSettled(
		models.map((m) => callClaude(env, m, 512, [{ role: 'user', content: prompt }])),
	);
	const lines = ['**📦 Batch Results**', ''];
	for (let i = 0; i < models.length; i++) {
		const r = results[i];
		lines.push(`**${models[i]}:**`);
		if (r.status === 'fulfilled') {
			lines.push(r.value.text.slice(0, 400) + (r.value.text.length > 400 ? '…' : ''));
		} else {
			lines.push(`Error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

export async function handleDebug(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const channelId = interaction.channel_id ?? 'dm';
	const session = await getSession(db, channelId);
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	return [
		'**🐛 Debug Info**',
		'```json',
		JSON.stringify({ session, project, settings: { model: settings.model, effortLevel: settings.effortLevel, maxTokens: settings.maxTokens } }, null, 2).slice(0, 1500),
		'```',
	].join('\n');
}

export async function handleFewerPermissions(
	_interaction: DiscordInteraction,
	_db: D1Database,
): Promise<string> {
	return '⚙️ Permission prompts are controlled by the Claude Code client settings, not the proxy. Run `claude config` in your terminal to adjust.';
}

export async function handleRun(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const workflow = opt(options, 'workflow') ?? '';
	if (!workflow) return '❌ Please provide a workflow name. Available: plan, review, code-review, security-review, qa, recap';
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const target = opt(options, 'target') ?? '';

	let steps;
	switch (workflow) {
		case 'plan':            steps = planWorkflow(target); break;
		case 'review':          steps = reviewWorkflow(target, settings.effortLevel); break;
		case 'code-review':     steps = codeReviewWorkflow(target); break;
		case 'security-review': steps = securityReviewWorkflow(target); break;
		case 'qa':              steps = qaWorkflow(target || 'current session'); break;
		case 'recap':           steps = recapWorkflow(target); break;
		default: return `❌ Unknown workflow \`${workflow}\`.`;
	}

	const result = await runWorkflow(env, steps, settings.model, settings.maxTokens);
	return `▶️ **Workflow: ${workflow}**\n\n${result.output}`;
}

export async function handleRunSkillGenerator(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
): Promise<string> {
	const description = opt(options, 'description') ?? 'a general-purpose workflow';
	const session = await getSession(db, interaction.channel_id ?? 'dm');
	const project = session?.projectName ? await getProject(db, session.projectName) : null;
	const settings = resolveSettings(env, session, project);
	const result = await callClaude(
		env,
		settings.model,
		2048,
		[{ role: 'user', content: `Generate a workflow definition for: ${description}\n\nFormat as a series of steps with system_prompt, user_prompt, and label for each step.` }],
	);
	return `🔧 **Skill Generator**\n\n${result.text}`;
}

export async function handleTeamOnboarding(): Promise<string> {
	return [
		'**👋 Team Onboarding — Claude Proxy**',
		'',
		'**What is this?**',
		'A Cloudflare Workers proxy that connects Claude Code to multiple AI providers,',
		'with Discord as a remote control surface.',
		'',
		'**Discord server structure:**',
		'• Each **category** = a project (configure with `/updateconfig`)',
		'• Each **channel** = an independent Claude session',
		'• Use **threads** for sub-tasks',
		'',
		'**Getting started:**',
		'1. `/ask <your question>` — start a conversation',
		'2. `/model claude-sonnet-4-6` — set your preferred model',
		'3. `/effort high` — increase detail level',
		'4. `/goal <objective>` — set a persistent goal for the session',
		'5. `/status` — check current settings',
		'',
		'**Key commands:** `/ask`, `/plan`, `/review`, `/qa`, `/insights`, `/help`',
	].join('\n');
}

export async function handleUpdateConfig(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	_env: Env,
	db: D1Database,
): Promise<string> {
	const key = opt(options, 'key') ?? '';
	const value = opt(options, 'value') ?? '';
	if (!key || !value) return '❌ Please provide both key and value.';

	const channelId = interaction.channel_id ?? 'dm';

	const settable: Record<string, () => Promise<string>> = {
		model: async () => { await upsertSession(db, { channelId, modelOverride: value }); return `✅ model → \`${value}\``; },
		effort: async () => {
			const valid: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
			if (!valid.includes(value as EffortLevel)) return `❌ Invalid effort level.`;
			await upsertSession(db, { channelId, effortLevel: value as EffortLevel });
			return `✅ effort → \`${value}\``;
		},
		goal: async () => { await setGoal(db, channelId, value); return `✅ goal → *${value}*`; },
	};

	const setter = settable[key];
	if (!setter) return `❌ Unknown config key \`${key}\`. Settable: ${Object.keys(settable).join(', ')}`;
	return setter();
}

// ---------------------------------------------------------------------------
// Cloud Run container — /cloudrun
// ---------------------------------------------------------------------------

export async function handleCloudRun(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	_db: D1Database,
): Promise<string> {
	const goal = opt(options, 'goal') ?? '';
	if (!goal) return '❌ Please provide a goal.';

	if (!env.CLOUD_RUN_URL) {
		return '❌ `CLOUD_RUN_URL` is not configured. Set it as a wrangler secret pointing to your Cloud Run container.';
	}

	const channelId = interaction.channel_id ?? 'dm';
	const model = opt(options, 'model') ?? undefined;
	const runId = crypto.randomUUID();

	// Fire-and-forget — container posts to Discord when done
	const body: Record<string, unknown> = { goal, channel_id: channelId, run_id: runId };
	if (model) body.model = model;

	fetch(`${env.CLOUD_RUN_URL}/run`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(env.CONTAINER_SECRET ? { Authorization: `Bearer ${env.CONTAINER_SECRET}` } : {}),
		},
		body: JSON.stringify(body),
	}).catch(() => {}); // intentional fire-and-forget

	return [
		`🚀 **Cloud Run agent started** (\`${runId.slice(0, 8)}\`)`,
		`> ${goal}`,
		'',
		'Running in a Cloud Run container with full Claude Code. Updates will appear here automatically.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Cloudflare cloud agent — /agent
// ---------------------------------------------------------------------------

export async function handleAgentGoal(
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	_db: D1Database,
): Promise<string> {
	const goal = opt(options, 'goal') ?? '';
	if (!goal) return '❌ Please provide a goal.';

	if (!env.GOAL_AGENT) {
		return '❌ `GOAL_AGENT` Durable Object is not configured. Check wrangler.jsonc bindings.';
	}

	const channelId = interaction.channel_id ?? 'dm';

	// One agent per channel — keyed by channel ID
	const agentId = env.GOAL_AGENT.idFromName(channelId);
	const stub = env.GOAL_AGENT.get(agentId);

	const resp = await stub.fetch(new Request('http://agent', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action: 'start', goal, channel_id: channelId }),
	}));
	const result = (await resp.json()) as {
		error?: string;
		workflowId?: string;
		resumed?: boolean;
		priorTurns?: number;
	};

	if (result.error) return `❌ ${result.error}`;

	const resumeNote = result.resumed
		? ` *(continuing — ${result.priorTurns} prior turn${result.priorTurns !== 1 ? 's' : ''} in context)*`
		: '';

	return [
		`🤖 **Cloud agent started**${resumeNote} (\`${result.workflowId?.slice(0, 8) ?? 'unknown'}\`)`,
		`> ${goal}`,
		'',
		'Running on Cloudflare with durable execution. Updates will appear here.',
		'Use `/agentstop` to cancel · `/agentclear` to reset conversation history.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Stop cloud agent — /agentstop
// ---------------------------------------------------------------------------

export async function handleAgentStop(
	interaction: DiscordInteraction,
	_options: DiscordOption[],
	env: Env,
	_db: D1Database,
): Promise<string> {
	if (!env.GOAL_AGENT) {
		return '❌ `GOAL_AGENT` Durable Object is not configured.';
	}

	const channelId = interaction.channel_id ?? 'dm';
	const agentId = env.GOAL_AGENT.idFromName(channelId);
	const stub = env.GOAL_AGENT.get(agentId);

	const resp = await stub.fetch(new Request('http://agent', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action: 'stop' }),
	}));
	const result = (await resp.json()) as { message?: string; error?: string };

	return result.error ? `❌ ${result.error}` : `🛑 ${result.message ?? 'Stop signal sent.'}`;
}

// ---------------------------------------------------------------------------
// Clear agent conversation history — /agentclear
// ---------------------------------------------------------------------------

export async function handleAgentClear(
	interaction: DiscordInteraction,
	_options: DiscordOption[],
	env: Env,
	_db: D1Database,
): Promise<string> {
	if (!env.GOAL_AGENT) {
		return '❌ `GOAL_AGENT` Durable Object is not configured.';
	}

	const channelId = interaction.channel_id ?? 'dm';
	const agentId = env.GOAL_AGENT.idFromName(channelId);
	const stub = env.GOAL_AGENT.get(agentId);

	const resp = await stub.fetch(new Request('http://agent', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action: 'clear_history' }),
	}));
	const result = (await resp.json()) as { message?: string; error?: string };

	return result.error ? `❌ ${result.error}` : `🗑️ ${result.message ?? 'Conversation history cleared. Next /agent will start fresh.'}`;
}
