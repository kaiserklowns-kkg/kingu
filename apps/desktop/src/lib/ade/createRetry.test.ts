import { describe, expect, test } from 'bun:test';
import { CREATE_MAX_ATTEMPTS, createCandidate, isNameConflict, nextCandidate } from './createRetry';

describe('create retry on a name conflict (Orca)', () => {
	test('candidates and conflicts', () => {
		expect([0, 1, 2].map((a) => createCandidate('fix', a))).toEqual(['fix', 'fix-2', 'fix-3']);
		expect(isNameConflict("fatal: a branch named 'kingu/fix' already exists")).toBe(true);
		expect(isNameConflict("fatal: '/r/.kingu/worktrees/fix' already exists")).toBe(true);
		expect(isNameConflict('fatal: invalid reference: main')).toBe(false);
	});
	test('skips taken names and stops at the limit', () => {
		expect(nextCandidate('fix', 0, new Set(['fix-2']))).toEqual({ slug: 'fix-3', attempt: 2 });
		expect(nextCandidate('fix', CREATE_MAX_ATTEMPTS - 1, new Set())).toBeNull();
	});
});
