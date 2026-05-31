import type { Env } from '../types';
import { InteractionType, InteractionResponseType } from './discordTypes';
import type { DiscordInteraction } from './discordTypes';
import { verifyDiscordRequest } from './verifySignature';
import { editFollowup, EMBED_COLOR_AI, EMBED_COLOR_INFO } from './discordApi';
import { routeCommand } from './commandRouter';
import { sendFollowupWithButtons, sendError } from './followups';
import { isGuildAllowed, isBotUser } from './permissions';
import { checkUserLimit, checkChannelLimit, checkGuildLimit } from './rateLimit';
import { handleAsk, handleRecap, handleQa, handleStatus, MODEL_SELECTOR_SENTINEL, setModelFromSelector } from './commands';
import { getSession, setStatus } from '../sessions/sessionStore';
import { getHistory } from '../sessions/conversationStore';
import { resolveSettings } from '../sessions/settingsResolver';
import { getProject } from '../projects/projectSettings';
import type { ButtonAction } from './discordTypes';
import {
	buildProviderSelectRow,
	buildModelSelectRow,
	buildBackRow,
	findProvider,
} from './modelSelector';

// ---------------------------------------------------------------------------
// Model selector interaction handler
// ---------------------------------------------------------------------------

async function handleSelectMenu(
	customId: string,
	values: string[],
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<void> {
	const appId = env.DISCORD_APPLICATION_ID ?? interaction.application_id;
	const channelId = interaction.channel_id ?? 'dm';

	try {
		// Step 1 result: user picked a provider → show model list
		if (customId === 'model_provider_select') {
			const providerKey = values[0];
			const provider = findProvider(providerKey);
			if (!provider) {
				await editFollowup(appId, interaction.token, '❌ Unknown provider.');
				return;
			}
			const modelRow = buildModelSelectRow(providerKey);
			if (!modelRow) return;
			await editFollowup(
				appId,
				interaction.token,
				'',
				[modelRow, buildBackRow()],
				[{
					description: `**${provider.emoji} ${provider.label}** — choose a model:`,
					color: EMBED_COLOR_INFO,
				}],
			);
			return;
		}

		// "Back" button — re-show provider list
		if (customId === 'model_back') {
			await editFollowup(
				appId,
				interaction.token,
				'',
				[buildProviderSelectRow()],
				[{ description: '**Select a provider:**', color: EMBED_COLOR_INFO }],
			);
			return;
		}

		// Step 2 result: user picked a model → save it
		if (customId.startsWith('model_model_select:')) {
			const modelValue = values[0];
			await setModelFromSelector(db, channelId, interaction.guild_id, modelValue);

			// Find the human label for the confirmation message
			const providerKey = customId.slice('model_model_select:'.length);
			const provider = findProvider(providerKey);
			const modelEntry = provider?.models.find((m) => m.value === modelValue);
			const label = modelEntry ? `${provider!.emoji} ${provider!.label} › **${modelEntry.label}**` : `\`${modelValue}\``;

			await editFollowup(
				appId,
				interaction.token,
				'',
				[], // remove components
				[{
					description: `✅ Model set to ${label}\n\`${modelValue}\``,
					color: EMBED_COLOR_AI,
					footer: { text: 'Use /model to change it again' },
				}],
			);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		console.error('[discord] select menu error:', msg);
		await editFollowup(appId, interaction.token, `⚠️ Error: ${msg}`);
	}
}

// ---------------------------------------------------------------------------
// Button interaction handler (type 3 — MessageComponent)
// ---------------------------------------------------------------------------

async function handleButtonAction(
	action: ButtonAction,
	channelId: string,
	interaction: DiscordInteraction,
	env: Env,
	db: D1Database,
): Promise<void> {
	const appId = env.DISCORD_APPLICATION_ID ?? interaction.application_id;
	try {
		let response: string;

		switch (action) {
			case 'continue': {
				// Synthesize a "Continue" ask
				const fakeOpts = [{ name: 'message', value: 'Continue.' }];
				response = await handleAsk({ ...interaction, channel_id: channelId }, fakeOpts, env, db);
				break;
			}
			case 'retry': {
				const history = await getHistory(db, channelId, 20);
				const lastUser = [...history].reverse().find((m) => m.role === 'user');
				if (!lastUser) { response = '❌ No previous message to retry.'; break; }
				const fakeOpts = [{ name: 'message', value: lastUser.content }];
				response = await handleAsk({ ...interaction, channel_id: channelId }, fakeOpts, env, db);
				break;
			}
			case 'stop':
				await setStatus(db, channelId, 'stopped');
				response = '⏹️ Session stopped. Use `/ask` to send a new message or start a fresh session.';
				break;
			case 'stronger': {
				// Bump to a more capable model and continue
				const session = await getSession(db, channelId);
				const project = session?.projectName ? await getProject(db, session.projectName) : null;
				const current = resolveSettings(env, session, project);
				const stronger = current.model.includes('haiku') ? 'claude-sonnet-4-6' : 'claude-opus-4-7';
				const fakeOpts = [{ name: 'message', value: 'Continue with a stronger approach.' }];
				const channelInteraction = { ...interaction, channel_id: channelId };
				// Override model for this call
				const originalModel = env.DEFAULT_MODEL;
				(env as unknown as Record<string, unknown>).DEFAULT_MODEL = stronger;
				response = await handleAsk(channelInteraction, fakeOpts, env, db);
				(env as unknown as Record<string, unknown>).DEFAULT_MODEL = originalModel;
				response = `💪 *Upgraded to \`${stronger}\`*\n\n${response}`;
				break;
			}
			case 'status':
				response = await handleStatus({ ...interaction, channel_id: channelId }, env, db);
				break;
			case 'runqa':
				response = await handleQa({ ...interaction, channel_id: channelId }, env, db);
				break;
			case 'recap':
				response = await handleRecap({ ...interaction, channel_id: channelId }, env, db);
				break;
			default:
				response = `❌ Unknown button action: ${action}`;
		}

		const isAiAction = ['continue', 'retry', 'stronger'].includes(action);
		await sendFollowupWithButtons(appId, interaction.token, response, channelId, false);
		if (!isAiAction) await editFollowup(appId, interaction.token, response);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		console.error('[discord] button error:', msg);
		await sendError(appId, interaction.token, msg);
	}
}

// ---------------------------------------------------------------------------
// Main interaction handler
// ---------------------------------------------------------------------------

export async function handleDiscordInteraction(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	// 1. Verify Ed25519 signature
	const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY ?? '');
	if (!valid) return new Response('Unauthorized', { status: 401 });

	let interaction: DiscordInteraction;
	try {
		interaction = JSON.parse(body) as DiscordInteraction;
	} catch {
		return new Response('Bad Request', { status: 400 });
	}

	// 2. PING → PONG (Discord endpoint verification)
	if (interaction.type === InteractionType.Ping) {
		return Response.json({ type: InteractionResponseType.Pong });
	}

	// 3. Ignore bot users
	if (isBotUser(interaction)) return new Response(null, { status: 204 });

	// 4. Guild allowlist check
	if (!isGuildAllowed(interaction.guild_id, env)) {
		return Response.json({
			type: InteractionResponseType.ChannelMessage,
			data: { content: '❌ This server is not authorized to use this proxy.', flags: 64 },
		});
	}

	// 5. Rate limiting
	const userId = (interaction.member?.user ?? interaction.user)?.id ?? 'unknown';
	const channelId = interaction.channel_id ?? 'dm';
	const guildId = interaction.guild_id ?? 'dm';

	if (!checkUserLimit(userId) || !checkChannelLimit(channelId) || !checkGuildLimit(guildId)) {
		return Response.json({
			type: InteractionResponseType.ChannelMessage,
			data: { content: '⏱️ Rate limit exceeded. Please wait a moment before trying again.', flags: 64 },
		});
	}

	const db = env.DB!;
	const appId = env.DISCORD_APPLICATION_ID ?? interaction.application_id;

	// 6. Slash commands (type 2)
	if (interaction.type === InteractionType.ApplicationCommand) {
		const commandName = interaction.data?.name ?? 'unknown';
		const isAiCommand = ['ask', 'compact', 'plan', 'review', 'code-review', 'security-review',
			'recap', 'qa', 'verify', 'insights', 'loop', 'batch', 'run', 'run-skill-generator'].includes(commandName);

		ctx.waitUntil(
			(async () => {
				try {
					const response = await routeCommand(interaction, env, db);

					// /model returns a sentinel → show provider selector instead of text
					if (response === MODEL_SELECTOR_SENTINEL) {
						await editFollowup(
							appId,
							interaction.token,
							'',
							[buildProviderSelectRow()],
							[{ description: '**Select a provider:**', color: EMBED_COLOR_INFO }],
						);
						return;
					}

					if (isAiCommand) {
						await sendFollowupWithButtons(appId, interaction.token, response, channelId, commandName === 'loop');
					} else {
						await editFollowup(appId, interaction.token, response);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : 'Unknown error';
					console.error(`[discord] /${commandName} error:`, msg);
					await sendError(appId, interaction.token, msg);
				}
			})(),
		);

		return Response.json({ type: InteractionResponseType.DeferredChannelMessage });
	}

	// 7. Component interactions (type 3) — buttons AND select menus
	if (interaction.type === InteractionType.MessageComponent) {
		const customId = interaction.data?.custom_id ?? '';
		const componentType = interaction.data?.component_type ?? 2;

		// Select menus (component_type 3)
		if (componentType === 3) {
			const values = interaction.data?.values ?? [];
			ctx.waitUntil(handleSelectMenu(customId, values, interaction, env, db));
			return Response.json({ type: InteractionResponseType.DeferredMessageUpdate });
		}

		// "Back" button from model selector (button, but model-namespace custom_id)
		if (customId === 'model_back') {
			ctx.waitUntil(handleSelectMenu(customId, [], interaction, env, db));
			return Response.json({ type: InteractionResponseType.DeferredMessageUpdate });
		}

		// Regular action buttons
		const colonIdx = customId.indexOf(':');
		const action = (colonIdx >= 0 ? customId.slice(0, colonIdx) : customId) as ButtonAction;
		const targetChannel = colonIdx >= 0 ? customId.slice(colonIdx + 1) : channelId;

		ctx.waitUntil(handleButtonAction(action, targetChannel, interaction, env, db));
		return Response.json({ type: InteractionResponseType.DeferredMessageUpdate });
	}

	return Response.json({
		type: InteractionResponseType.ChannelMessage,
		data: { content: '❌ Unsupported interaction type.' },
	});
}
