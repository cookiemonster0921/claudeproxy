export const InteractionType = {
	Ping: 1,
	ApplicationCommand: 2,
	MessageComponent: 3,
} as const;

export const InteractionResponseType = {
	Pong: 1,
	ChannelMessage: 4,
	DeferredChannelMessage: 5,
	DeferredMessageUpdate: 6,
	UpdateMessage: 7,
} as const;

export const ComponentType = { ActionRow: 1, Button: 2 } as const;
export const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 } as const;

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export type ButtonAction = 'continue' | 'retry' | 'stop' | 'stronger' | 'status' | 'runqa' | 'recap';

export interface DiscordUser {
	id: string;
	username: string;
	global_name?: string;
	bot?: boolean;
}

export interface DiscordOption {
	name: string;
	value?: string | number | boolean;
	options?: DiscordOption[];
}

export interface DiscordInteraction {
	id: string;
	application_id: string;
	type: number;
	data?: {
		name?: string;
		options?: DiscordOption[];
		custom_id?: string;
		component_type?: number;
		/** Populated for select menu interactions (component_type 3) */
		values?: string[];
	};
	guild_id?: string;
	channel_id?: string;
	member?: { user: DiscordUser; roles: string[] };
	user?: DiscordUser;
	token: string;
}

export interface DiscordButton {
	type: 2;
	style: number;
	label: string;
	custom_id: string;
	emoji?: { name: string };
}

export interface DiscordActionRow {
	type: 1;
	components: DiscordButton[];
}

export interface DiscordEmbed {
	description?: string;
	color?: number;
	footer?: { text: string };
	fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordSession {
	channel_id: string;
	guild_id?: string;
	category_id?: string;
	thread_id?: string;
	session_id?: string;
	project_name?: string;
	model_override?: string;
	effort_level?: EffortLevel;
	status?: 'active' | 'stopped';
	goal?: string;
	message_count?: number;
	created_at: string;
	updated_at: string;
}

export interface DiscordMessage {
	id: number;
	channel_id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
}

export interface DiscordProject {
	project_name: string;
	guild_id?: string;
	category_id?: string;
	category_name?: string;
	repo_url?: string;
	default_model?: string;
	provider?: string;
	system_prompt?: string;
	budget_usd?: number;
	created_at: string;
	updated_at: string;
}
