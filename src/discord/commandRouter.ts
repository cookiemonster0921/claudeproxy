import type { Env } from '../types';
import type { DiscordInteraction, DiscordOption } from './discordTypes';
import { isAdmin, extractMemberRoles, adminCommandsEnabled } from './permissions';
import * as handlers from './commands';

type CommandHandler = (
	interaction: DiscordInteraction,
	options: DiscordOption[],
	env: Env,
	db: D1Database,
) => Promise<string>;

const ADMIN_COMMANDS = new Set([
	'agents',
	'mcp',
	'memory',
	'hooks',
	'batch',
	'debug',
	'fewer-permission-prompts',
	'run',
	'run-skill-generator',
	'team-onboarding',
	'updateconfig',
	'cloudrun',
	'agent',
	'agentstop',
	'agentclear',
]);

const COMMAND_MAP: Record<string, CommandHandler> = {
	// Core — no AI call
	status:  (i, _o, e, db) => handlers.handleStatus(i, e, db),
	model:   (i, o, _e, db)  => handlers.handleModel(i, o, db),
	effort:  (i, o, _e, db)  => handlers.handleEffort(i, o, db),
	context: (i, _o, e, db) => handlers.handleContext(i, e, db),
	goal:    (i, o, _e, db)  => handlers.handleGoal(i, o, db),
	help:    (_i, _o, _e, _db) => handlers.handleHelp(),
	export:  (i, o, _e, db)  => handlers.handleExport(i, o, db),

	// Core — AI call
	ask:              (i, o, e, db) => handlers.handleAsk(i, o, e, db),
	compact:          (i, o, e, db) => handlers.handleCompact(i, o, e, db),
	plan:             (i, o, e, db) => handlers.handlePlan(i, o, e, db),
	review:           (i, o, e, db) => handlers.handleReview(i, o, e, db),
	'code-review':    (i, o, e, db) => handlers.handleCodeReview(i, o, e, db),
	'security-review':(i, o, e, db) => handlers.handleSecurityReview(i, o, e, db),
	recap:            (i, _o, e, db) => handlers.handleRecap(i, e, db),
	insights:         (i, _o, e, db) => handlers.handleInsights(i, e, db),
	qa:               (i, _o, e, db) => handlers.handleQa(i, e, db),
	verify:           (i, o, e, db) => handlers.handleVerify(i, o, e, db),
	loop:             (i, o, e, db) => handlers.handleLoop(i, o, e, db),

	// Cloud agents
	cloudrun:    (i, o, e, db) => handlers.handleCloudRun(i, o, e, db),
	agent:       (i, o, e, db) => handlers.handleAgentGoal(i, o, e, db),
	agentstop:   (i, o, e, db) => handlers.handleAgentStop(i, o, e, db),
	agentclear:  (i, o, e, db) => handlers.handleAgentClear(i, o, e, db),

	// Admin
	agents:                   (i, _o, e, db) => handlers.handleAgents(i, e, db),
	mcp:                      (_i, _o, e, _db) => handlers.handleMcp(e),
	memory:                   (i, _o, e, db) => handlers.handleMemory(i, e, db),
	hooks:                    () => Promise.resolve('🔗 **Hooks:** No external hooks configured. This feature is reserved for future integrations.'),
	batch:                    (i, o, e, db) => handlers.handleBatch(i, o, e, db),
	debug:                    (i, _o, e, db) => handlers.handleDebug(i, e, db),
	'fewer-permission-prompts': (i, _o, _e, db) => handlers.handleFewerPermissions(i, db),
	run:                      (i, o, e, db) => handlers.handleRun(i, o, e, db),
	'run-skill-generator':    (i, o, e, db) => handlers.handleRunSkillGenerator(i, o, e, db),
	'team-onboarding':        (_i, _o, _e, _db) => handlers.handleTeamOnboarding(),
	updateconfig:             (i, o, e, db) => handlers.handleUpdateConfig(i, o, e, db),
};

export async function routeCommand(
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<string> {
	const commandName = interaction.data?.name ?? '';
	const options = interaction.data?.options ?? [];

	if (ADMIN_COMMANDS.has(commandName)) {
		if (!adminCommandsEnabled(env)) {
			return '❌ Admin commands are disabled on this proxy.';
		}
		const roles = extractMemberRoles(interaction);
		if (!isAdmin(roles, env)) {
			return '❌ You need an admin role to use this command.';
		}
	}

	const handler = COMMAND_MAP[commandName];
	if (!handler) {
		return `❌ Unknown command \`/${commandName}\`. Try \`/help\`.`;
	}

	return handler(interaction, options, env, db);
}
