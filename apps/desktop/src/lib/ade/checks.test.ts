import { expect, test } from 'bun:test';
import { prSignature, checksPollDelay, CHECKS_POLL, checkKind, checkLabel, checkRank, mergeLabel, reactionPills, summarize, type Check, type Pr } from './checks';

const run = (conclusion: string, status = 'COMPLETED'): Check => ({ __typename: 'CheckRun', name: conclusion, status, conclusion });

test('kinds, labels and order', () => {
	expect(checkKind(run('SUCCESS'))).toBe('success');
	expect(checkKind(run('', 'IN_PROGRESS'))).toBe('pending');
	expect(checkKind({ context: 'ci', state: 'ERROR' })).toBe('failure');
	expect(checkLabel(run('TIMED_OUT'))).toBe('Timed out');
	expect(checkLabel(run('', 'QUEUED'))).toBe('Queued');
	const sorted = [run('SKIPPED'), run('SUCCESS'), run('FAILURE'), run('', 'IN_PROGRESS')].sort((a, b) => checkRank(a) - checkRank(b));
	expect(sorted.map(checkKind)).toEqual(['failure', 'pending', 'success', 'skipped']);
});

test('summary and merge label', () => {
	const counts = summarize([run('SUCCESS'), run('SKIPPED'), run('FAILURE'), run('', 'QUEUED'), run('NEUTRAL')]);
	expect(counts).toEqual({ passed: 2, failed: 1, pending: 1, neutral: 1 });
	const pr = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: '' } as Pr;
	expect(mergeLabel(pr, counts)).toBe('Checks failed');
	expect(mergeLabel({ ...pr, mergeable: 'CONFLICTING' }, counts)).toBe('Conflicts');
	expect(mergeLabel(pr, { passed: 3, failed: 0, pending: 0, neutral: 0 })).toBe('Checks passed');
	expect(mergeLabel({ ...pr, state: 'MERGED' }, counts)).toBe('Merged');
});

test('reaction pills keep GitHub order and skip zero counts', () => {
	const pills = reactionPills({ reactionGroups: [{ content: 'HEART', users: { totalCount: 2 } }, { content: 'THUMBS_UP', reactors: { totalCount: 1 }, viewerHasReacted: true }, { content: 'EYES', users: { totalCount: 0 } }] });
	expect(pills.map((p) => [p.emoji, p.count, p.mine])).toEqual([['👍', 1, true], ['❤️', 2, false]]);
});

test('checks poll delay follows the PR and its checks', () => {
	const pr = (state: Pr['state'], checks: Check[]) => ({ state, statusCheckRollup: checks }) as Pr;
	const ok = { failed: false, unchanged: true, prev: 60_000 };
	expect(checksPollDelay(null, ok)).toBe(CHECKS_POLL.base);
	expect(checksPollDelay(pr('OPEN', [run('', 'IN_PROGRESS')]), { ...ok, prev: 120_000 })).toBe(60_000);
	expect(checksPollDelay(pr('OPEN', [run('SUCCESS')]), ok)).toBe(120_000);
	expect(checksPollDelay(pr('OPEN', [run('SUCCESS')]), { ...ok, unchanged: false, prev: 120_000 })).toBe(60_000);
	expect(checksPollDelay(pr('MERGED', [run('SUCCESS')]), ok)).toBeNull();
	expect(checksPollDelay(pr('MERGED', [run('', 'QUEUED')]), ok)).toBe(60_000);
	expect(checksPollDelay(pr('CLOSED', []), ok)).toBe(15 * 60_000);
	expect(checksPollDelay(null, { failed: true, unchanged: false, prev: 60_000 })).toBe(120_000);
	expect(checksPollDelay(null, { failed: true, unchanged: false, prev: 10 * 60_000 })).toBe(15 * 60_000);
});

test('a PR signature changes with its state and checks only', () => {
	const pr = { state: 'OPEN', title: 'a', statusCheckRollup: [run('', 'IN_PROGRESS')] } as Pr;
	expect(prSignature(null)).toBe('');
	expect(prSignature({ ...pr, title: 'b' })).toBe(prSignature(pr));
	expect(prSignature({ ...pr, statusCheckRollup: [run('SUCCESS')] })).not.toBe(prSignature(pr));
	expect(prSignature({ ...pr, state: 'MERGED' })).not.toBe(prSignature(pr));
});
