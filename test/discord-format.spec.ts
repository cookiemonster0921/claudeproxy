import { describe, it, expect } from 'vitest';
import { exportHistory } from '../src/sessions/conversationStore';
import type { ConversationMessage } from '../src/sessions/conversationStore';

function msg(role: 'user' | 'assistant', content: string): ConversationMessage {
	return { role, content, timestamp: '2026-01-01T00:00:00Z' };
}

// ---------------------------------------------------------------------------
// exportHistory
// ---------------------------------------------------------------------------

describe('exportHistory — txt format', () => {
	it('formats messages as plain text', () => {
		const result = exportHistory([msg('user', 'hello'), msg('assistant', 'world')], 'txt');
		expect(result).toContain('[User]');
		expect(result).toContain('[Claude]');
		expect(result).toContain('hello');
		expect(result).toContain('world');
	});

	it('returns empty string for empty history', () => {
		expect(exportHistory([], 'txt')).toBe('');
	});
});

describe('exportHistory — md format', () => {
	it('formats messages as markdown', () => {
		const result = exportHistory([msg('user', 'hello'), msg('assistant', 'world')], 'md');
		expect(result).toContain('**User**');
		expect(result).toContain('**Claude**');
		expect(result).toContain('hello');
		expect(result).toContain('world');
	});

	it('separates messages with horizontal rules', () => {
		const result = exportHistory([msg('user', 'a'), msg('assistant', 'b')], 'md');
		expect(result).toContain('---');
	});
});

// ---------------------------------------------------------------------------
// Rate limiter — structural test (no timing dependencies)
// ---------------------------------------------------------------------------

describe('checkRateLimit', () => {
	it('allows requests within limit', async () => {
		const { checkRateLimit } = await import('../src/discord/rateLimit');
		const key = `test-${Math.random()}`;
		expect(checkRateLimit(key, 60_000, 5)).toBe(true);
		expect(checkRateLimit(key, 60_000, 5)).toBe(true);
	});

	it('blocks after limit exceeded', async () => {
		const { checkRateLimit } = await import('../src/discord/rateLimit');
		const key = `test-${Math.random()}`;
		for (let i = 0; i < 3; i++) checkRateLimit(key, 60_000, 3);
		expect(checkRateLimit(key, 60_000, 3)).toBe(false);
	});

	it('different keys are independent', async () => {
		const { checkRateLimit } = await import('../src/discord/rateLimit');
		const key1 = `k1-${Math.random()}`;
		const key2 = `k2-${Math.random()}`;
		for (let i = 0; i < 3; i++) checkRateLimit(key1, 60_000, 3);
		checkRateLimit(key1, 60_000, 3); // exceeded
		expect(checkRateLimit(key2, 60_000, 3)).toBe(true); // independent
	});
});
