import type { Env } from '../types';
import { PROVIDER_CATALOG } from '../model-router';
import { InteractionResponseType, InteractionType } from './discordTypes';
import type { DiscordInteraction } from './discordTypes';
import { verifyDiscordRequest } from './verifySignature';

const EPHEMERAL = 64;
const LAUNCH_COMMANDS = new Set(['cloudshell', 'computeengine', 'cloudrunjobs', 'local']);

const PROVIDER_LABELS: Record<string, string> = {
	workers_ai: 'Workers AI',
	google_ai: 'Google AI',
	openrouter: 'OpenRouter',
	nvidia_nim: 'NVIDIA NIM',
};

function availableModelOptions(env: Env) {
	return PROVIDER_CATALOG
		.filter(model => !model.requires_key || !!(env as unknown as Record<string, string | undefined>)[model.requires_key])
		.map(model => ({
			label: `${PROVIDER_LABELS[model.owned_by] ?? model.owned_by} / ${model.display_name}`,
			value: model.id,
			description: `Route through ${PROVIDER_LABELS[model.owned_by] ?? model.owned_by}`,
		}));
}

function buildModelSelect(runtime: string, initiatorId: string, env: Env) {
	return {
		type: 1,
		components: [{
			type: 3,
			custom_id: `ops_model_select:${runtime}:${initiatorId}`,
			placeholder: 'Choose provider / model',
			options: availableModelOptions(env),
		}],
	};
}

function buildAllowedUsersSelect(runtime: string, modelIndex: number, initiatorId: string) {
	return {
		type: 1,
		components: [{
			type: 5,
			custom_id: `ops_user_select:${runtime}:${modelIndex}:${initiatorId}`,
			placeholder: 'Choose allowed Discord users',
			min_values: 0,
			max_values: 25,
		}],
	};
}

function interactionUserId(interaction: DiscordInteraction): string | undefined {
	return (interaction.member?.user ?? interaction.user)?.id;
}

function helpText(): string {
	return [
		'**Claude Code Operations Bot**',
		'',
		'Use a launch command, then choose one `provider / model` option from the dropdown.',
		'',
		'`/cloudshell` - temporary Google Cloud Shell session for testing.',
		'`/computeengine` - persistent Google Compute Engine session.',
		'`/cloudrunjobs` - experimental time-limited Cloud Run Job session.',
		'`/local` - local runtime placeholder; configuration will be added later.',
		'`/help` - show this guide.',
		'',
		'Launch execution is intentionally disabled while the configuration wizard is under development.',
	].join('\n');
}

/**
 * Minimal operations-bot interaction endpoint.
 *
 * This intentionally does not launch infrastructure yet. The next phase will
 * turn each launch command into a component wizard:
 *   1. Show a combined provider/model select menu.
 *   2. Show a multi-select Discord user picker for the session allowlist.
 *   3. Show a confirmation button.
 *   4. Dispatch the selected runtime launch operation asynchronously.
 */
export async function handleOpsDiscordInteraction(
	request: Request,
	env: Env,
): Promise<Response> {
	const { valid, body } = await verifyDiscordRequest(request, env.OPS_BOT_PUBLIC_KEY ?? '');
	if (!valid) return new Response('Unauthorized', { status: 401 });

	let interaction: DiscordInteraction;
	try {
		interaction = JSON.parse(body) as DiscordInteraction;
	} catch {
		return new Response('Bad Request', { status: 400 });
	}

	if (interaction.type === InteractionType.Ping) {
		return Response.json({ type: InteractionResponseType.Pong });
	}

	if (interaction.type === InteractionType.ApplicationCommand) {
		const command = interaction.data?.name ?? '';
		if (command === 'help') {
			return Response.json({
				type: InteractionResponseType.ChannelMessage,
				data: { content: helpText(), flags: EPHEMERAL },
			});
		}

		if (LAUNCH_COMMANDS.has(command)) {
			const initiatorId = interactionUserId(interaction);
			if (!initiatorId) {
				return Response.json({
					type: InteractionResponseType.ChannelMessage,
					data: { content: 'Could not identify the user who started this command.', flags: EPHEMERAL },
				});
			}

			return Response.json({
				type: InteractionResponseType.ChannelMessage,
				data: {
					content: `Configure \`/${command}\`: choose a provider / model.`,
					flags: EPHEMERAL,
					components: [buildModelSelect(command, initiatorId, env)],
				},
			});
		}

		return Response.json({
			type: InteractionResponseType.ChannelMessage,
			data: { content: 'Unknown operations command.', flags: EPHEMERAL },
		});
	}

	if (interaction.type === InteractionType.MessageComponent) {
		const customId = interaction.data?.custom_id ?? '';
		if (customId.startsWith('ops_model_select:')) {
			const [runtime, initiatorId] = customId.slice('ops_model_select:'.length).split(':');
			const model = interaction.data?.values?.[0];
			const modelIndex = PROVIDER_CATALOG.findIndex(entry => entry.id === model);
			if (!LAUNCH_COMMANDS.has(runtime) || !initiatorId || !model || modelIndex === -1) {
				return Response.json({
					type: InteractionResponseType.UpdateMessage,
					data: { content: 'Invalid runtime or model selection.', components: [] },
				});
			}

			return Response.json({
				type: InteractionResponseType.UpdateMessage,
				data: {
					content: [
						`Selected runtime: \`${runtime}\``,
						`Selected provider / model: \`${model}\``,
						'',
						`Choose users allowed to send messages to the Claude session. <@${initiatorId}> will always be included.`,
					].join('\n'),
					components: [buildAllowedUsersSelect(runtime, modelIndex, initiatorId)],
				},
			});
		}

		if (customId.startsWith('ops_user_select:')) {
			const [runtime, rawModelIndex, initiatorId] = customId.slice('ops_user_select:'.length).split(':');
			const model = PROVIDER_CATALOG[Number(rawModelIndex)];
			if (!LAUNCH_COMMANDS.has(runtime) || !model || !initiatorId) {
				return Response.json({
					type: InteractionResponseType.UpdateMessage,
					data: { content: 'Invalid allowed-user selection.', components: [] },
				});
			}

			const allowedUserIds = [...new Set([initiatorId, ...(interaction.data?.values ?? [])])];

			// Next phase: persist this configuration and show a confirmation
			// button before dispatching the selected runtime launch operation.
			return Response.json({
				type: InteractionResponseType.UpdateMessage,
				data: {
					content: [
						`Selected runtime: \`${runtime}\``,
						`Selected provider / model: \`${model.id}\``,
						'Allowed users:',
						...allowedUserIds.map(userId => `- <@${userId}>`),
						'',
						'Confirmation and launch execution will be added next. No infrastructure was launched.',
					].join('\n'),
					components: [],
				},
			});
		}
	}

	return new Response(null, { status: 204 });
}
