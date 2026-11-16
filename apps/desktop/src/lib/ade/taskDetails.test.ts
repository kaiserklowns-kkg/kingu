import { describe, expect, test } from 'bun:test';
import { detailsPatch, issueFromUrl, MAX_COMMENT } from './taskDetails';

describe('Edit Worktree Details', () => {
	test('GitHub and Linear URLs become issue links', () => {
		expect(issueFromUrl('https://github.com/acme/app/issues/42#issuecomment-1')).toEqual({ number: 42, url: 'https://github.com/acme/app/issues/42', title: '#42', provider: 'github', key: 'acme/app#42' });
		expect(issueFromUrl('https://github.com/acme/app/pull/7/files')?.url).toBe('https://github.com/acme/app/pull/7');
		expect(issueFromUrl('https://linear.app/acme/issue/eng-123/fix-login')).toEqual({ number: 123, url: 'https://linear.app/acme/issue/ENG-123', title: 'ENG-123', provider: 'linear', key: 'ENG-123' });
		expect(issueFromUrl('https://example.com/acme/app/issues/1')).toBeNull();
		expect(issueFromUrl('not a url')).toBeNull();
		expect(issueFromUrl('javascript:alert(1)')).toBeNull();
	});
	test('the patch keeps an unchanged issue and refuses bad input', () => {
		const old = { number: 1, url: 'https://github.com/a/b/issues/1', title: 'Real title' };
		expect(detailsPatch({ issue: old }, { comment: '  ', issueUrl: old.url })).toEqual({ comment: null, issue: old });
		expect(detailsPatch({ issue: old }, { comment: 'wip', issueUrl: '' })).toEqual({ comment: 'wip', issue: null });
		expect(detailsPatch({ issue: null }, { comment: '', issueUrl: 'https://x.y/z' })).toEqual({ error: 'badIssue' });
		expect(detailsPatch({ issue: null }, { comment: 'x'.repeat(MAX_COMMENT + 1), issueUrl: '' })).toEqual({ error: 'longComment' });
	});
});
