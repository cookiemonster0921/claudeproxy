import { describe, it, expect } from 'vitest';
import { isGuildAllowed, isAdmin, isBotUser } from '../src/discord/permissions';
import type { Env } from '../src/types';
import type { DiscordInteraction } from '../src/discord/discordTypes';

function makeEnv(partial: Partial<Env> = {}): Env {
	return { AI: {} as Ai, ...partial } as Env;
}

function makeInteraction(partial: Partial<DiscordInteraction> = {}): DiscordInteraction {
	return {
		id: '1',
		application_id: '2',
		type: 2,
		token: 'tok',
		...partial,
	};
}

// ---------------------------------------------------------------------------
// isGuildAllowed
// ---------------------------------------------------------------------------

describe('isGuildAllowed', () => {
	it('allows all guilds when DISCORD_ALLOWED_GUILD_IDS is unset', () => {
		expect(isGuildAllowed('any-guild', makeEnv())).toBe(true);
		expect(isGuildAllowed(undefined, makeEnv())).toBe(true);
	});

	it('allows matching guild IDs', () => {
		const env = makeEnv({ DISCORD_ALLOWED_GUILD_IDS: 'guild1, guild2' });
		expect(isGuildAllowed('guild1', env)).toBe(true);
		expect(isGuildAllowed('guild2', env)).toBe(true);
	});

	it('blocks non-matching guild IDs', () => {
		const env = makeEnv({ DISCORD_ALLOWED_GUILD_IDS: 'guild1' });
		expect(isGuildAllowed('guild99', env)).toBe(false);
	});

	it('blocks undefined guildId when list is set', () => {
		const env = makeEnv({ DISCORD_ALLOWED_GUILD_IDS: 'guild1' });
		expect(isGuildAllowed(undefined, env)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isAdmin
// ---------------------------------------------------------------------------

describe('isAdmin', () => {
	it('allows all users when DISCORD_ADMIN_ROLE_IDS is unset', () => {
		expect(isAdmin(['some-role'], makeEnv())).toBe(true);
		expect(isAdmin([], makeEnv())).toBe(true);
	});

	it('allows user with matching role', () => {
		const env = makeEnv({ DISCORD_ADMIN_ROLE_IDS: 'admin-role, mod-role' });
		expect(isAdmin(['admin-role'], env)).toBe(true);
		expect(isAdmin(['user-role', 'mod-role'], env)).toBe(true);
	});

	it('blocks user without matching role', () => {
		const env = makeEnv({ DISCORD_ADMIN_ROLE_IDS: 'admin-role' });
		expect(isAdmin(['user-role'], env)).toBe(false);
		expect(isAdmin([], env)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isBotUser
// ---------------------------------------------------------------------------

describe('isBotUser', () => {
	it('returns false for human users', () => {
		const interaction = makeInteraction({ user: { id: 'u1', username: 'alice' } });
		expect(isBotUser(interaction)).toBe(false);
	});

	it('returns true for bot users', () => {
		const interaction = makeInteraction({ user: { id: 'b1', username: 'mybot', bot: true } });
		expect(isBotUser(interaction)).toBe(true);
	});

	it('returns true for bot members', () => {
		const interaction = makeInteraction({
			member: { user: { id: 'b1', username: 'mybot', bot: true }, roles: [] },
		});
		expect(isBotUser(interaction)).toBe(true);
	});

	it('returns false when no user info present', () => {
		const interaction = makeInteraction();
		expect(isBotUser(interaction)).toBe(false);
	});
});
