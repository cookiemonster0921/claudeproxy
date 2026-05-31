import { describe, it, expect } from 'vitest';
import { resolveSettings, effortDescription } from '../src/sessions/settingsResolver';
import type { Session } from '../src/sessions/sessionStore';
import type { ProjectSettings } from '../src/projects/projectSettings';
import type { Env } from '../src/types';

function makeEnv(partial: Partial<Env> = {}): Env {
	return {
		AI: {} as Ai,
		MODEL: undefined,
		DEFAULT_MODEL: undefined,
		...partial,
	} as Env;
}

function makeSession(partial: Partial<Session> = {}): Session {
	return {
		channelId: 'ch1',
		effortLevel: 'auto',
		status: 'active',
		messageCount: 0,
		createdAt: '',
		updatedAt: '',
		...partial,
	};
}

function makeProject(partial: Partial<ProjectSettings> = {}): ProjectSettings {
	return {
		projectName: 'test-project',
		budgetUsd: 0,
		...partial,
	};
}

describe('resolveSettings — model resolution', () => {
	it('uses command override first', () => {
		const result = resolveSettings(makeEnv({ MODEL: 'env-model' }), makeSession({ modelOverride: 'session-model' }), null, { model: 'override-model' });
		expect(result.model).toBe('override-model');
	});

	it('uses session modelOverride second', () => {
		const result = resolveSettings(makeEnv({ MODEL: 'env-model' }), makeSession({ modelOverride: 'session-model' }), null);
		expect(result.model).toBe('session-model');
	});

	it('uses project defaultModel third', () => {
		const result = resolveSettings(makeEnv({ MODEL: 'env-model' }), makeSession(), makeProject({ defaultModel: 'project-model' }));
		expect(result.model).toBe('project-model');
	});

	it('uses DEFAULT_MODEL env var fourth', () => {
		const result = resolveSettings(makeEnv({ DEFAULT_MODEL: 'default-model', MODEL: 'env-model' }), makeSession(), null);
		expect(result.model).toBe('default-model');
	});

	it('uses MODEL env var fifth', () => {
		const result = resolveSettings(makeEnv({ MODEL: 'env-model' }), makeSession(), null);
		expect(result.model).toBe('env-model');
	});

	it('falls back to claude-sonnet-4-6', () => {
		const result = resolveSettings(makeEnv(), null, null);
		expect(result.model).toBe('claude-sonnet-4-6');
	});
});

describe('resolveSettings — effort level', () => {
	it('maps low effort to 512 maxTokens', () => {
		const result = resolveSettings(makeEnv(), null, null, { effort: 'low' });
		expect(result.maxTokens).toBe(512);
	});

	it('maps max effort to 8192 maxTokens', () => {
		const result = resolveSettings(makeEnv(), null, null, { effort: 'max' });
		expect(result.maxTokens).toBe(8192);
	});

	it('auto defaults to 4096 maxTokens', () => {
		const result = resolveSettings(makeEnv(), null, null);
		expect(result.maxTokens).toBe(4096);
	});

	it('injects system prompt snippet for high effort', () => {
		const result = resolveSettings(makeEnv(), makeSession({ effortLevel: 'high' }), null);
		expect(result.systemPromptAddition).toContain('step by step');
	});

	it('injects concise snippet for low effort', () => {
		const result = resolveSettings(makeEnv(), makeSession({ effortLevel: 'low' }), null);
		expect(result.systemPromptAddition).toContain('concise');
	});

	it('adds no snippet for auto effort', () => {
		const result = resolveSettings(makeEnv(), makeSession({ effortLevel: 'auto' }), null);
		// no effort snippet, but may have project/goal additions
		expect(result.systemPromptAddition).toBe('');
	});
});

describe('resolveSettings — goal injection', () => {
	it('includes goal in system prompt addition', () => {
		const result = resolveSettings(makeEnv(), makeSession({ goal: 'build a great API' }), null);
		expect(result.systemPromptAddition).toContain('build a great API');
	});
});

describe('effortDescription', () => {
	it('returns a string for every level', () => {
		const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
		for (const l of levels) {
			expect(typeof effortDescription(l)).toBe('string');
			expect(effortDescription(l).length).toBeGreaterThan(0);
		}
	});
});
