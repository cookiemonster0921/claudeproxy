// GoalAgent — Durable Object that persists goal state and orchestrates GoalWorkflow.
// One agent instance per Discord channel (named by channel ID).
// Stores conversation history in DO SQLite so new goals can resume prior sessions.

import { Agent } from 'agents';
import type { Env, AnthropicMessage } from '../types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Maximum number of messages to keep in history (user+assistant pairs = 2 per turn)
const MAX_HISTORY_MESSAGES = 40; // last 20 turns

export interface GoalAgentState {
	status: 'idle' | 'running' | 'done' | 'stopped' | 'error';
	goal: string | null;
	channelId: string | null;
	turnsCompleted: number;
	workflowId: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
	// Conversation history — persisted across workflow runs for session continuation
	conversationJson: string | null; // JSON.stringify(AnthropicMessage[])
}

// ---------------------------------------------------------------------------
// GoalAgent
// ---------------------------------------------------------------------------

export class GoalAgent extends Agent<Env, GoalAgentState> {
	initialState: GoalAgentState = {
		status: 'idle',
		goal: null,
		channelId: null,
		turnsCompleted: 0,
		workflowId: null,
		startedAt: null,
		finishedAt: null,
		lastError: null,
		conversationJson: null,
	};

	async onRequest(req: Request): Promise<Response> {
		let body: Record<string, unknown>;
		try {
			body = (await req.json()) as Record<string, unknown>;
		} catch {
			return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
		}

		const action = body.action as string;

		switch (action) {
			case 'start':         return this._handleStart(body);
			case 'stop':          return this._handleStop();
			case 'status':        return this._ok(this.state);
			case 'update':        return this._handleUpdate(body);
			case 'save_messages': return this._handleSaveMessages(body);
			case 'clear_history': return this._handleClearHistory();
			default:
				return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
		}
	}

	private async _handleStart(body: Record<string, unknown>): Promise<Response> {
		const goal = body.goal as string | undefined;
		const channelId = body.channel_id as string | undefined;

		if (!goal) return this._err('goal is required');
		if (!channelId) return this._err('channel_id is required');

		if (this.state.status === 'running') {
			return this._ok({ error: 'Agent is already running. Use /agentstop to cancel first.' });
		}

		const workflowId = crypto.randomUUID();
		const now = new Date().toISOString();

		// Retrieve prior conversation to pass to the new workflow
		const priorMessages = this._getPriorMessages();
		const hasPrior = priorMessages.length > 0;

		this.setState({
			...this.state,
			status: 'running',
			goal,
			channelId,
			turnsCompleted: 0,
			workflowId,
			startedAt: now,
			finishedAt: null,
			lastError: null,
			// Keep conversationJson intact — workflow will update it when done
		});

		if (!this.env.GOAL_WORKFLOW) {
			return this._err('GOAL_WORKFLOW binding not configured');
		}

		await this.env.GOAL_WORKFLOW.create({
			id: workflowId,
			params: {
				goal,
				channelId,
				agentName: this.name,
				priorMessages: hasPrior ? priorMessages : [],
			},
		});

		return this._ok({
			workflowId,
			status: 'started',
			resumed: hasPrior,
			priorTurns: Math.floor(priorMessages.length / 2),
		});
	}

	private _handleStop(): Response {
		if (this.state.status !== 'running') {
			return this._ok({ message: 'No running agent to stop.' });
		}
		this.setState({
			...this.state,
			status: 'stopped',
			finishedAt: new Date().toISOString(),
		});
		return this._ok({ message: 'Agent stop signal sent.' });
	}

	private _handleUpdate(body: Record<string, unknown>): Response {
		const update: Partial<GoalAgentState> = {};
		if (typeof body.turnsCompleted === 'number') update.turnsCompleted = body.turnsCompleted;
		if (typeof body.status === 'string') update.status = body.status as GoalAgentState['status'];
		if (typeof body.lastError === 'string') update.lastError = body.lastError;
		if (body.status === 'done' || body.status === 'error') {
			update.finishedAt = new Date().toISOString();
		}
		this.setState({ ...this.state, ...update });
		return this._ok({ ok: true });
	}

	private _handleSaveMessages(body: Record<string, unknown>): Response {
		const messagesJson = body.messages_json as string | undefined;
		if (!messagesJson) return this._err('messages_json is required');
		try {
			// Validate it's parseable JSON before storing
			const messages = JSON.parse(messagesJson) as AnthropicMessage[];
			// Trim to MAX_HISTORY_MESSAGES to keep state lean
			const trimmed = messages.length > MAX_HISTORY_MESSAGES
				? messages.slice(messages.length - MAX_HISTORY_MESSAGES)
				: messages;
			this.setState({ ...this.state, conversationJson: JSON.stringify(trimmed) });
			return this._ok({ ok: true, saved: trimmed.length });
		} catch {
			return this._err('messages_json must be a valid JSON array');
		}
	}

	private _handleClearHistory(): Response {
		this.setState({ ...this.state, conversationJson: null });
		return this._ok({ ok: true, message: 'Conversation history cleared.' });
	}

	// Extract prior messages from state (returns [] if none stored)
	private _getPriorMessages(): AnthropicMessage[] {
		if (!this.state.conversationJson) return [];
		try {
			return JSON.parse(this.state.conversationJson) as AnthropicMessage[];
		} catch {
			return [];
		}
	}

	private _ok(data: unknown): Response {
		return new Response(JSON.stringify(data), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	private _err(message: string): Response {
		return new Response(JSON.stringify({ error: message }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}
