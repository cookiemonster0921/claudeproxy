import type { Env } from '../types';
import type { DiscordInteraction } from './discordTypes';

export function isGuildAllowed(guildId: string | undefined, env: Env): boolean {
	const allowed = env.DISCORD_ALLOWED_GUILD_IDS?.trim();
	if (!allowed) return true;
	if (!guildId) return false;
	return allowed.split(',').map((s) => s.trim()).includes(guildId);
}

export function extractMemberRoles(interaction: DiscordInteraction): string[] {
	return interaction.member?.roles ?? [];
}

export function isAdmin(memberRoles: string[], env: Env): boolean {
	const adminRoles = env.DISCORD_ADMIN_ROLE_IDS?.trim();
	if (!adminRoles) return true; // no restriction set — everyone is admin
	const allowed = adminRoles.split(',').map((s) => s.trim());
	return memberRoles.some((r) => allowed.includes(r));
}

export function isBotUser(interaction: DiscordInteraction): boolean {
	const user = interaction.member?.user ?? interaction.user;
	return user?.bot === true;
}

export function adminCommandsEnabled(env: Env): boolean {
	return env.DISCORD_ENABLE_ADMIN_COMMANDS !== 'false';
}

export function storeMessagesEnabled(env: Env): boolean {
	return env.DISCORD_STORE_MESSAGES === 'true';
}
