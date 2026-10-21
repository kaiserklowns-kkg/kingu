import { describe, expect, test } from 'bun:test';
import { fileOf, isDiffKey, parseRefDiffKey, refDiffKey, tabLabel } from '#lib/workbench/scm.ts';
import { changesSlug, isChangesKey } from '#lib/workbench/viewers.ts';
import { fileRevisions, isHistoryChangesKey, parseHistoryChangesKey, rangeChangesKey, stashChangesKey, stashChangesPrefix } from './rangeChanges';

describe('history changes keys', () => {
	test('a range round-trips and is a changes page of no task', () => {
		const key = rangeChangesKey('/w/my repo', 'origin/main', 'abc123', 'origin/main ↔ abc/1');
		expect(isChangesKey(key) && isHistoryChangesKey(key)).toBe(true);
		expect(changesSlug(key)).toBe('');
		expect(parseHistoryChangesKey(key)).toEqual({ kind: 'range', repo: '/w/my repo', from: 'origin/main', to: 'abc123', title: 'origin/main ↔ abc/1' });
		const commit = parseHistoryChangesKey(rangeChangesKey('/w', null, 'abc', 'x'))!;
		expect(commit).toMatchObject({ from: null, to: 'abc' });
		expect(fileRevisions(commit)).toEqual({ left: 'abc^', right: 'abc' });
	});

	test('a stash round-trips; its untracked files come from the third parent', () => {
		const key = stashChangesKey('/w', 2, 'f00', 'stash@{2}: wip');
		const s = parseHistoryChangesKey(key)!;
		expect(s).toEqual({ kind: 'stash', repo: '/w', index: 2, hash: 'f00', title: 'stash@{2}: wip' });
		expect(key.startsWith(stashChangesPrefix('/w'))).toBe(true);
		expect(fileRevisions(s)).toEqual({ left: 'f00^1', right: 'f00' });
		expect(fileRevisions(s, true)).toEqual({ left: 'f00^3^', right: 'f00^3' });
	});

	test('malformed keys and task keys are not ours', () => {
		expect(parseHistoryChangesKey('changes:my-task')).toBeNull();
		expect(changesSlug('changes:my-task')).toBe('my-task');
		expect(parseHistoryChangesKey('changes:@range/a/b')).toBeNull();
		expect(parseHistoryChangesKey('changes:@stash/a/x/h/t')).toBeNull();
		expect(parseHistoryChangesKey('changes:@range/%E0/_/x/t')).toBeNull();
	});
});

describe('refdiff keys', () => {
	test('two revisions, or one and the working copy, with a rename', () => {
		const key = refDiffKey('feature/x', 'abc', 'src/new.ts', 'src/old.ts');
		expect(parseRefDiffKey(key)).toEqual({ left: 'feature/x', right: 'abc', rel: 'src/new.ts', before: 'src/old.ts' });
		expect(isDiffKey(key)).toBe(true);
		expect(fileOf(key)).toBe('src/new.ts');
		const working = refDiffKey('v1.0', null, '/abs/other/a.ts');
		expect(parseRefDiffKey(working)).toEqual({ left: 'v1.0', right: null, rel: '/abs/other/a.ts', before: '/abs/other/a.ts' });
		expect(tabLabel(working)).toBe('a.ts (v1.0 ↔ Working Tree)');
		const hash = '0123456789abcdef0123456789abcdef01234567';
		expect(tabLabel(refDiffKey(`${hash}^`, hash, 'a.ts'))).toBe('a.ts (0123456^ ↔ 0123456)');
		expect(parseRefDiffKey('refdiff://x')).toBeNull();
	});
});
