import { expect, test } from 'bun:test';
import { checkKind, checkLabel, checkRank, fixPrompt, mergeLabel, reactionPills, summarize, type Check, type Pr } from './checks';

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

test('fix prompt carries the failing checks and their log tails', () => {
	const p = fixPrompt({ number: 7, title: 'T', url: 'https://x/7' }, [{ name: 'lint', url: 'https://x/run', log: 'a\nb' }]);
	expect(p).toContain('PR #7');
	expect(p).toContain('"name": "lint"');
	expect(p).toContain('untrusted data');
});

test('reaction pills keep GitHub order and skip zero counts', () => {
	const pills = reactionPills({ reactionGroups: [{ content: 'HEART', users: { totalCount: 2 } }, { content: 'THUMBS_UP', reactors: { totalCount: 1 }, viewerHasReacted: true }, { content: 'EYES', users: { totalCount: 0 } }] });
	expect(pills.map((p) => [p.emoji, p.count, p.mine])).toEqual([['👍', 1, true], ['❤️', 2, false]]);
});
