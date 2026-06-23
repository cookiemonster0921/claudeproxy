import type { Env } from '../types';
import { PROVIDER_CATALOG } from '../model-router';
import { InteractionResponseType, InteractionType } from './discordTypes';
import type { DiscordInteraction } from './discordTypes';
import { verifyDiscordRequest } from './verifySignature';

const EPHEMERAL = 64;
const LAUNCH_COMMANDS = new Set(['cloudshell', 'computeengine', 'oracle', 'cloudrunjobs', 'modal', 'northflank', 'local', 'macstudio']);

// ── LauncherDO helpers ────────────────────────────────────────────────────────

/** Call the LauncherDO binding directly (no external HTTP). Returns null if DO not configured. */
async function launcherDo(env: Env, path: 'store' | 'dispatch' | 'status', body?: unknown): Promise<Response | null> {
	if (!env.LAUNCHER_DO) return null;
	const id = env.LAUNCHER_DO.idFromName('global');
	const stub = env.LAUNCHER_DO.get(id);
	const method = path === 'status' ? 'GET' : 'POST';
	return stub.fetch(
		new Request(`https://launcher-do/${path}`, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined,
		}),
	);
}

/** Confirm + Cancel action row for a pending local launch. */
function buildLaunchConfirmRow(token: string) {
	return {
		type: 1,
		components: [
			{
				type: 2,
				style: 3, // Success (green)
				label: '🚀 Launch session',
				custom_id: `ops_launch:${token}`,
			},
			{
				type: 2,
				style: 4, // Danger (red)
				label: 'Cancel',
				custom_id: `ops_cancel:${token}`,
			},
		],
	};
}

/**
 * Build the cproxy command string to send to the daemon.
 * Claude runs locally on the user's machine; it routes through the deployed
 * Cloudflare Worker (prod) so it doesn't need Wrangler to be running.
 */
function buildCproxyCommand(opts: {
	channelId: string;
	allowedUserIds: string[];
	modelId: string;
	/** True for headless runtimes (VM, Modal, Northflank) — skips trust dialog and onboarding prompts. */
	headless?: boolean;
}): string {
	const users = opts.allowedUserIds.join(',');
	// Each channel gets its own state directory so sessions don't share access.json.
	// Without this, launching session B overwrites session A's channel config and
	// session A drops all inbound messages (they fail its local access check).
	const stateDir = `~/.claude/discord-sessions/${opts.channelId}`;
	// Escape for safe shell embedding (no untrusted input here, but be explicit)
	const parts = [
		`DISCORD_STATE_DIR=${stateDir}`,
		'claude-proxy.sh on prod',
		`--channels "plugin:discord@claude-plugins-official"`,
		`--discord-channel ${opts.channelId}`,
	];
	if (users) parts.push(`--discord-users ${users}`);
	if (opts.modelId) parts.push(`--model ${opts.modelId}`);
	// Headless runtimes (VMs, Mac Studio background sessions) have no interactive
	// user to answer trust/permission dialogs — skip them automatically.
	if (opts.headless) parts.push(`--dangerously-skip-permissions`);
	return parts.join(' \\\n  ');
}

/**
 * Per-runtime troubleshooting / monitoring instructions shown in the ops bot's
 * launch-confirmation responses. Keyed by `target` (matches LAUNCHER_TARGET).
 */
const RUNTIME_OPS_INFO: Record<string, { noDaemon: string[]; monitor: string[] }> = {
	local: {
		noDaemon: [
			'The `discord_session_launcher.py` daemon is not running on your local machine.',
			'Start it:',
			'```sh',
			'python3 discord_session_launcher.py',
			'```',
		],
		monitor: [
			'A new terminal tab should open on your local machine within seconds.',
		],
	},
	computeengine: {
		noDaemon: [
			'The `discord_session_launcher.py` daemon on the **GCE VM** is not connected.',
			'Check its status / logs:',
			'```sh',
			'./scripts/gce/setup-launcher.sh --status',
			'./scripts/gce/setup-launcher.sh --logs',
			'```',
			'If the service is stopped, SSH in and restart it:',
			'```sh',
			'./scripts/gce/provision-vm.sh --connect',
			'sudo systemctl restart claude-launcher',
			'```',
		],
		monitor: [
			'A background tmux session is starting on the **GCE VM**.',
			'',
			'Monitor it:',
			'```sh',
			'./scripts/gce/setup-launcher.sh --logs    # tail launcher daemon logs',
			'./scripts/gce/setup-launcher.sh --status  # service status + active tmux sessions',
			'```',
			'Or SSH in directly:',
			'```sh',
			'./scripts/gce/provision-vm.sh --connect',
			'tmux ls                                   # list sessions',
			'tmux attach -t cproxy_<id>                # view the live Claude session (Ctrl-b d to detach)',
			'tail -f ~/.claude/discord-sessions/logs/<id>.log',
			'```',
		],
	},
	oracle: {
		noDaemon: [
			'The `discord_session_launcher.py` daemon on the **Oracle Cloud (OCI) VM** is not connected.',
			'Check its status / logs:',
			'```sh',
			'./scripts/oracle/setup-launcher.sh --status',
			'./scripts/oracle/setup-launcher.sh --logs',
			'```',
			'If the service is stopped, SSH in and restart it:',
			'```sh',
			'./scripts/oracle/provision-vm.sh --connect',
			'sudo systemctl restart claude-launcher',
			'```',
		],
		monitor: [
			'A background tmux session is starting on the **Oracle Cloud (OCI) VM**.',
			'',
			'Monitor it:',
			'```sh',
			'./scripts/oracle/setup-launcher.sh --logs    # tail launcher daemon logs',
			'./scripts/oracle/setup-launcher.sh --status  # service status + active tmux sessions',
			'```',
			'Or SSH in directly:',
			'```sh',
			'./scripts/oracle/provision-vm.sh --connect',
			'tmux ls                                   # list sessions',
			'tmux attach -t cproxy_<id>                # view the live Claude session (Ctrl-b d to detach)',
			'tail -f ~/.claude/discord-sessions/logs/<id>.log',
			'```',
		],
	},
	modal: {
		noDaemon: [
			'The Modal launcher app is not connected.',
			'Deploy (or redeploy) it:',
			'```sh',
			'modal deploy scripts/modal/modal_launcher.py',
			'```',
		],
		monitor: [
			'A tmux session is starting inside the **Modal** container.',
			'',
			'Monitor it:',
			'```sh',
			'modal app logs claude-launcher',
			'```',
			'Or check the running app in the Modal dashboard.',
		],
	},
	northflank: {
		noDaemon: [
			'The **Northflank** launcher service is not connected.',
			'Make sure it is deployed and running:',
			'```sh',
			'./scripts/northflank/setup.sh',
			'```',
		],
		monitor: [
			'A tmux session is starting inside the **Northflank** deployment service.',
			'',
			'Monitor it in the Northflank dashboard → your service → **Logs**,',
			'or via the Northflank CLI:',
			'```sh',
			'northflank get service logs --project <project> --service <service>',
			'```',
		],
	},
	macstudio: {
		noDaemon: [
			'The `discord_session_launcher.py` daemon on your **Mac Studio** is not connected.',
			'Start it (or ensure launchd is running it):',
			'```sh',
			'LAUNCHER_TARGET=macstudio python3 discord_session_launcher.py',
			'```',
			'Or load the launchd service if configured:',
			'```sh',
			'launchctl start ai.jortelligence.session-launcher',
			'```',
		],
		monitor: [
			'A background tmux session is starting on your **Mac Studio**.',
			'',
			'Monitor it on the Mac Studio:',
			'```sh',
			'tmux ls                            # list sessions',
			'tmux attach -t cproxy_<id>         # view the live session (Ctrl-b d to detach)',
			'tail -f ~/.claude/discord-sessions/logs/<id>.log',
			'```',
		],
	},
};

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
		'Use a launch command, then choose a `provider / model` and allowed users.',
		'',
		'`/local` — launch on your **local machine** (opens a terminal tab).',
		'`/computeengine` — launch on a **Google Compute Engine** VM (tmux, background).',
		'`/oracle` — launch on an **Oracle Cloud (OCI)** VM (tmux, background).',
		'`/modal` — launch inside a **Modal** always-on container (`modal deploy`).',
		'`/northflank` — launch inside a **Northflank** persistent service.',
		'`/macstudio` — launch on your **Mac Studio** (tmux, background, always-on).',
		'`/cloudshell` — Google Cloud Shell (stub, not yet implemented).',
		'`/cloudrunjobs` — Cloud Run Jobs (stub, not yet implemented).',
		'`/help` — show this guide.',
		'',
		'Each runtime requires its own `discord_session_launcher.py` daemon configured with the matching `LAUNCHER_TARGET`.',
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

			// ── Daemon-dispatched runtimes: store config in LauncherDO, show Confirm button ──
			// 'local'         → daemon on your local machine, opens a visible terminal tab
			// 'computeengine' → daemon on a Google Compute Engine VM (tmux, background)
			// 'oracle'        → daemon on an Oracle Cloud Infrastructure VM (tmux, background)
			// 'modal'         → daemon inside a Modal web_server container (always-on)
			// 'northflank'    → daemon inside a Northflank persistent deployment service
			if (runtime === 'local' || runtime === 'computeengine' || runtime === 'oracle' || runtime === 'modal' || runtime === 'northflank' || runtime === 'macstudio') {
				const channelId = interaction.channel_id ?? '';
				const command = buildCproxyCommand({
					channelId,
					allowedUserIds,
					modelId: model.id,
					headless: runtime !== 'local',
				});
				const sessionId = crypto.randomUUID().slice(0, 8);
				// local opens a GUI window; VM has no display so use background tmux
				const mode = runtime === 'local' ? 'terminal' : 'background';

				const stored = await launcherDo(env, 'store', {
					command,
					session_id: sessionId,
					target: runtime, // daemon routing: each daemon only handles its own target
					mode,            // 'terminal' | 'background'
				});
				if (!stored) {
					const daemonName = runtime === 'local'
						? 'local machine'
						: 'Oracle Cloud VM (LAUNCHER_TARGET=computeengine)';
					return Response.json({
						type: InteractionResponseType.UpdateMessage,
						data: {
							content: [
								'⚠️ **Launcher not configured.**',
								'`LAUNCHER_DO` is not bound in the Worker — the daemon relay is unavailable.',
								'',
								`Deploy the Worker with \`wrangler deploy\` to enable it, then make sure`,
								`\`discord_session_launcher.py\` is running on the ${daemonName}.`,
								'',
								'**Command that would have run:**',
								`\`\`\`sh\n${command}\n\`\`\``,
							].join('\n'),
							components: [],
						},
					});
				}

				const { token } = (await stored.json()) as { token: string };

				const LOCATION: Record<string, string> = {
					local:         'a new terminal tab on your **local machine**',
					computeengine: 'a background tmux session on the **Google Compute Engine VM**',
					oracle:        'a background tmux session on the **Oracle Cloud (OCI) VM**',
					modal:         'a tmux session inside the **Modal container** (`modal deploy`)',
					northflank:    'a tmux session inside the **Northflank deployment service**',
					macstudio:     'a background tmux session on your **Mac Studio**',
				};
				const DAEMON_HINT: Record<string, string> = {
					local:         'The `discord_session_launcher.py` daemon must be running on your local machine.',
					computeengine: 'The `discord_session_launcher.py` daemon must be running on the GCE VM (`LAUNCHER_TARGET=computeengine`).',
					oracle:        'The `discord_session_launcher.py` daemon must be running on the OCI VM (`LAUNCHER_TARGET=oracle`).',
					modal:         'The Modal app must be deployed: `modal deploy scripts/modal/modal_launcher.py` (`LAUNCHER_TARGET=modal`).',
					northflank:    'The Northflank service must be running: `./scripts/northflank/setup.sh` (`LAUNCHER_TARGET=northflank`).',
					macstudio:     'The `discord_session_launcher.py` daemon must be running on your Mac Studio (`LAUNCHER_TARGET=macstudio`).',
				};
				const locationDesc = LOCATION[runtime] ?? `a session on \`${runtime}\``;
				const daemonHint   = DAEMON_HINT[runtime] ?? `The \`${runtime}\` daemon must be running.`;

				return Response.json({
					type: InteractionResponseType.UpdateMessage,
					data: {
						content: [
							`**Session ready to launch**`,
							`Runtime: \`${runtime}\`  •  Mode: \`${mode}\`  •  Model: \`${model.id}\``,
							`Channel: <#${channelId}>`,
							`Allowed users: ${allowedUserIds.map((id) => `<@${id}>`).join(', ')}`,
							'',
							`This will open ${locationDesc}.`,
							daemonHint,
						].join('\n'),
						components: [buildLaunchConfirmRow(token)],
					},
				});
			}

			// ── Other runtimes: stub (cloud launch not yet implemented) ───────
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

		// ── Launch confirmed: dispatch to LauncherDO ──────────────────────────
		if (customId.startsWith('ops_launch:')) {
			const token = customId.slice('ops_launch:'.length);
			const dispatched = await launcherDo(env, 'dispatch', { token });

			if (!dispatched) {
				return Response.json({
					type: InteractionResponseType.UpdateMessage,
					data: {
						content: '⚠️ LAUNCHER_DO not configured — cannot dispatch.',
						components: [],
					},
				});
			}

			if (dispatched.status === 404) {
				return Response.json({
					type: InteractionResponseType.UpdateMessage,
					data: {
						content: '⏱️ **Launch token expired.** Please run `/local` again.',
						components: [],
					},
				});
			}

			const result = (await dispatched.json()) as {
				ok: boolean;
				sent: number;
				connected: number;
				target?: string;
				mode?: string;
			};
			const runtime = result.target ?? 'local';
			const info = RUNTIME_OPS_INFO[runtime] ?? RUNTIME_OPS_INFO.local;

			if (!result.ok || result.sent === 0) {
				return Response.json({
					type: InteractionResponseType.UpdateMessage,
					data: {
						content: [
							`⚠️ **No daemons connected** (${result.connected} online) for \`${runtime}\`.`,
							'',
							...info.noDaemon,
							'',
							'Then click **🚀 Launch session** again (or re-run the slash command to start over).',
						].join('\n'),
						components: [],
					},
				});
			}

			return Response.json({
				type: InteractionResponseType.UpdateMessage,
				data: {
					content: [
						`✅ **Launch command sent** to ${result.sent} daemon${result.sent === 1 ? '' : 's'} (\`${runtime}\`).`,
						...info.monitor,
						'',
						'Once the session starts it will respond to messages in this channel.',
					].join('\n'),
					components: [],
				},
			});
		}

		// ── Launch cancelled ──────────────────────────────────────────────────
		if (customId.startsWith('ops_cancel:')) {
			return Response.json({
				type: InteractionResponseType.UpdateMessage,
				data: { content: 'Launch cancelled.', components: [] },
			});
		}
	}

	return new Response(null, { status: 204 });
}
