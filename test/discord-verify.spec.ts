import { describe, it, expect } from 'vitest';
import { splitMessage, buildActionRow } from '../src/discord/followups';

// ---------------------------------------------------------------------------
// verifySignature — unit tests (no real key pair; test structural behaviour)
// ---------------------------------------------------------------------------

describe('discord verifySignature', () => {
	it('returns valid=false when signature headers are missing', async () => {
		const { verifyDiscordRequest } = await import('../src/discord/verifySignature');
		const req = new Request('http://example.com', { method: 'POST', body: '{}' });
		const result = await verifyDiscordRequest(req, 'aabbcc');
		expect(result.valid).toBe(false);
		expect(typeof result.body).toBe('string');
	});

	it('returns valid=false for a bad public key', async () => {
		const { verifyDiscordRequest } = await import('../src/discord/verifySignature');
		const req = new Request('http://example.com', {
			method: 'POST',
			body: '{"type":1}',
			headers: {
				'x-signature-ed25519': 'deadbeef'.repeat(8),
				'x-signature-timestamp': String(Math.floor(Date.now() / 1000)),
			},
		});
		const result = await verifyDiscordRequest(req, 'notahexkey');
		expect(result.valid).toBe(false);
	});

	it('returns body text even when invalid', async () => {
		const { verifyDiscordRequest } = await import('../src/discord/verifySignature');
		const body = '{"type":1,"id":"test"}';
		const req = new Request('http://example.com', {
			method: 'POST',
			body,
			headers: {
				'x-signature-ed25519': 'aa'.repeat(32),
				'x-signature-timestamp': '1234567890',
			},
		});
		const result = await verifyDiscordRequest(req, 'bb'.repeat(32));
		expect(result.body).toBe(body);
	});
});

// ---------------------------------------------------------------------------
// splitMessage
// ---------------------------------------------------------------------------

describe('splitMessage', () => {
	it('returns single chunk for short messages', () => {
		const result = splitMessage('Hello world');
		expect(result).toHaveLength(1);
		expect(result[0]).toBe('Hello world');
	});

	it('splits a long message at paragraph boundary', () => {
		const para = 'A'.repeat(1000);
		const text = `${para}\n\n${para}\n\n${para}`;
		const chunks = splitMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(1990);
		}
	});

	it('handles messages exactly at the limit', () => {
		const text = 'X'.repeat(1990);
		const chunks = splitMessage(text);
		expect(chunks).toHaveLength(1);
	});

	it('handles messages one over the limit', () => {
		const text = 'X'.repeat(1991);
		const chunks = splitMessage(text);
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(1990);
		}
	});
});

// ---------------------------------------------------------------------------
// buildActionRow
// ---------------------------------------------------------------------------

describe('buildActionRow', () => {
	it('returns an action row with buttons containing channelId', () => {
		const row = buildActionRow('123456');
		expect(row.type).toBe(1);
		expect(row.components.length).toBeGreaterThan(0);
		expect(row.components.every((b) => b.custom_id.includes('123456'))).toBe(true);
	});

	it('includes stop button when includeStop=true', () => {
		const row = buildActionRow('999', true);
		const ids = row.components.map((b) => b.custom_id);
		expect(ids.some((id) => id.startsWith('stop:'))).toBe(true);
	});

	it('does not exceed 5 buttons', () => {
		const row = buildActionRow('abc', true);
		expect(row.components.length).toBeLessThanOrEqual(5);
	});
});
