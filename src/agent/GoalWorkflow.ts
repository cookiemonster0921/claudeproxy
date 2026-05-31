// GoalWorkflow — durable agentic loop running on Cloudflare Workflows.
// Each step is checkpointed; survives eviction and restarts.
// Supports session continuation: priorMessages from GoalAgent state are prepended.

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env, AnthropicMessage, AnthropicAssistantResponse, TextContentBlock, ToolUseContentBlock } from '../types';
import { loadSettings } from '../config';
import { ProxyService } from '../proxy-service';
import { buildTools, executeTool } from './agentTools';
import { buildSystemPrompt } from './systemPrompt';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalParams {
	goal: string;
	channelId: string;
	agentName: string;
	priorMessages: AnthropicMessage[]; // empty [] for first run, populated on continuation
}

const MAX_TURNS = 30;
const DISCORD_API = 'https://discord.com/api/v10';

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

async function notifyDiscord(env: Env, channelId: string, content: string): Promise<void> {
	if (!env.DISCORD_BOT_TOKEN || !channelId) return;
	const msg = content.length > 1950 ? content.slice(0, 1950) + '\n*(truncated)*' : content;
	await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
		method: 'POST',
		headers: {
			Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ content: msg }),
	}).catch((e) => console.error('[GoalWorkflow] Discord notify failed:', e));
}

// ---------------------------------------------------------------------------
// Agent helpers
// ---------------------------------------------------------------------------

async function getAgentStatus(env: Env, agentName: string): Promise<string | null> {
	if (!env.GOAL_AGENT) return null;
	try {
		const id = env.GOAL_AGENT.idFromName(agentName);
		const stub = env.GOAL_AGENT.get(id);
		const resp = await stub.fetch(new Request('http://agent', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'status' }),
		}));
		const data = (await resp.json()) as { status?: string };
		return data.status ?? null;
	} catch {
		return null;
	}
}

async function updateAgentState(env: Env, agentName: string, update: Record<string, unknown>): Promise<void> {
	if (!env.GOAL_AGENT) return;
	try {
		const id = env.GOAL_AGENT.idFromName(agentName);
		const stub = env.GOAL_AGENT.get(id);
		await stub.fetch(new Request('http://agent', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'update', ...update }),
		}));
	} catch (e) {
		console.error('[GoalWorkflow] Agent state update failed:', e);
	}
}

/** Persist conversation messages to GoalAgent for future continuation. */
async function saveMessagesToAgent(
	env: Env,
	agentName: string,
	messages: AnthropicMessage[],
): Promise<void> {
	if (!env.GOAL_AGENT) return;
	try {
		const id = env.GOAL_AGENT.idFromName(agentName);
		const stub = env.GOAL_AGENT.get(id);
		await stub.fetch(new Request('http://agent', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save_messages',
				messages_json: JSON.stringify(messages),
			}),
		}));
	} catch (e) {
		console.error('[GoalWorkflow] saveMessages failed:', e);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(response: AnthropicAssistantResponse): string {
	const parts: string[] = [];
	for (const block of response.content) {
		if (block.type === 'text') parts.push((block as TextContentBlock).text);
	}
	return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// GoalWorkflow
// ---------------------------------------------------------------------------

export class GoalWorkflow extends WorkflowEntrypoint<Env, GoalParams> {
	async run(event: Readonly<WorkflowEvent<GoalParams>>, step: WorkflowStep): Promise<void> {
		const { goal, channelId, agentName, priorMessages } = event.payload;
		const tools = buildTools();
		const systemPrompt = buildSystemPrompt(tools);

		// Build initial messages:
		// - If resuming: prior conversation + new user goal appended
		// - If fresh: just the new user goal
		const isResume = priorMessages.length > 0;
		let messages: AnthropicMessage[] = isResume
			? [...priorMessages, { role: 'user', content: goal }]
			: [{ role: 'user', content: goal }];

		await step.do('notify-start', async () => {
			const resumeNote = isResume
				? ` *(resuming — ${Math.floor(priorMessages.length / 2)} prior turns loaded)*`
				: '';
			await notifyDiscord(
				this.env,
				channelId,
				`🤖 **Cloud agent started**${resumeNote}\n> ${goal}\n\nRunning on Cloudflare. Use \`/agentstop\` to cancel.`,
			);
			return null;
		});

		let finalMessages = messages; // track last known messages for persistence

		for (let turn = 0; turn < MAX_TURNS; turn++) {
			// Check for external stop signal
			const agentStatus = await step.do(`check-stop-${turn}`, async () => {
				return getAgentStatus(this.env, agentName);
			}) as string | null;

			if (agentStatus === 'stopped') {
				await step.do(`notify-stopped-${turn}`, async () => {
					await notifyDiscord(this.env, channelId, `🛑 **Agent stopped** after ${turn} turn${turn !== 1 ? 's' : ''}.`);
					await saveMessagesToAgent(this.env, agentName, finalMessages);
					return null;
				});
				break;
			}

			// LLM call
			const llmJson = await step.do(`llm-${turn}`, {
				retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
			}, async () => {
				const settings = loadSettings(this.env);
				const service = new ProxyService(settings, this.env);
				const body = {
					model: 'claude-sonnet-4-6',
					max_tokens: 8192,
					system: systemPrompt,
					messages,
					tools,
					stream: false as const,
				};
				const response = await service.handleMessages(body, crypto.randomUUID());
				return response.text();
			}) as unknown as string;

			const llmResponse = JSON.parse(llmJson) as AnthropicAssistantResponse;

			// End turn
			if (llmResponse.stop_reason === 'end_turn' || !llmResponse.content.length) {
				const text = extractText(llmResponse);

				// Append final assistant message to history before saving
				finalMessages = [...messages, { role: 'assistant', content: llmResponse.content }];

				await step.do(`notify-done-${turn}`, async () => {
					await notifyDiscord(
						this.env,
						channelId,
						`✅ **Agent done** (${turn + 1} turn${turn === 0 ? '' : 's'})\n\n${text || '*(no output)*'}`,
					);
					await updateAgentState(this.env, agentName, { status: 'done', turnsCompleted: turn + 1 });
					// Persist conversation for next /agent command in this channel
					await saveMessagesToAgent(this.env, agentName, finalMessages);
					return null;
				});
				break;
			}

			// Tool use
			if (llmResponse.stop_reason === 'tool_use') {
				const toolCalls = llmResponse.content.filter(
					(b): b is ToolUseContentBlock => b.type === 'tool_use',
				);

				const toolResultsJson = await step.do(`tools-${turn}`, {
					retries: { limit: 2, delay: '5 seconds' },
				}, async () => {
					const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
					for (const call of toolCalls) {
						let result: string;
						try {
							result = await executeTool(call.name, call.input, {
								VALTOWN_API_KEY: this.env.VALTOWN_API_KEY,
								GITHUB_TOKEN: this.env.GITHUB_TOKEN,
							});
						} catch (e) {
							result = `Error: ${e instanceof Error ? e.message : String(e)}`;
						}
						results.push({ type: 'tool_result', tool_use_id: call.id, content: result });
					}
					return JSON.stringify(results);
				}) as unknown as string;

				const toolResults = JSON.parse(toolResultsJson) as Array<{
					type: 'tool_result';
					tool_use_id: string;
					content: string;
				}>;

				messages = [
					...messages,
					{ role: 'assistant' as const, content: llmResponse.content },
					{ role: 'user' as const, content: toolResults },
				];
				finalMessages = messages;

				await step.do(`update-agent-${turn}`, async () => {
					await updateAgentState(this.env, agentName, { turnsCompleted: turn + 1 });
					return null;
				});

				// Progress update every 5 turns
				if ((turn + 1) % 5 === 0) {
					const toolNames = toolCalls.map((b) => b.name).join(', ');
					await step.do(`notify-progress-${turn}`, async () => {
						await notifyDiscord(this.env, channelId, `🔄 **Turn ${turn + 1}** — called \`${toolNames}\``);
						return null;
					});
				}

				continue;
			}

			// Unexpected stop reason
			const text = extractText(llmResponse);
			finalMessages = [...messages, { role: 'assistant', content: llmResponse.content }];
			await step.do(`notify-unexpected-${turn}`, async () => {
				await notifyDiscord(
					this.env,
					channelId,
					`⚠️ **Agent ended unexpectedly** (stop_reason=${llmResponse.stop_reason}) after ${turn + 1} turns.\n\n${text}`,
				);
				await updateAgentState(this.env, agentName, {
					status: 'error',
					lastError: `Unexpected stop_reason: ${llmResponse.stop_reason}`,
					turnsCompleted: turn + 1,
				});
				await saveMessagesToAgent(this.env, agentName, finalMessages);
				return null;
			});
			break;
		}
	}
}
