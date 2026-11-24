import { describe, expect, test } from 'bun:test';
import { issueUrlRef, parseIssueUrl, siteHost, titleAfterLink } from './issueUrl';

describe('parseIssueUrl', () => {
	test('GitHub issues on any host, never pull requests', () => {
		expect(parseIssueUrl(' https://github.com/acme/app/issues/12 ')).toEqual({ provider: 'github', url: 'https://github.com/acme/app/issues/12', host: 'github.com', repo: 'acme/app', number: 12 });
		expect(parseIssueUrl('https://GHE.acme.dev/acme/app/issues/7#issuecomment-1')?.url).toBe('https://ghe.acme.dev/acme/app/issues/7');
		expect(parseIssueUrl('https://github.com/acme/app/pull/12')).toBeNull();
		expect(parseIssueUrl('https://github.com/acme/app/issues/0')).toBeNull();
		expect(parseIssueUrl('http://github.com/acme/app/issues/3')).toBeNull();
	});

	test('GitLab issues and work items, nested groups', () => {
		expect(parseIssueUrl('https://gitlab.com/group/sub/app/-/issues/5')).toEqual({ provider: 'gitlab', url: 'https://gitlab.com/group/sub/app/-/issues/5', host: 'gitlab.com', project: 'group/sub/app', number: 5 });
		expect(parseIssueUrl('https://git.acme.dev/g/app/-/work_items/9')).toMatchObject({ provider: 'gitlab', project: 'g/app', number: 9 });
		expect(parseIssueUrl('https://gitlab.com/g/app/-/merge_requests/9')).toBeNull();
		expect(parseIssueUrl('https://gitlab.com/app/-/issues/9')).toBeNull();
	});

	test('Jira browse links, key in upper case, a context path kept', () => {
		expect(parseIssueUrl('https://acme.atlassian.net/browse/eng-123')).toEqual({ provider: 'jira', url: 'https://acme.atlassian.net/browse/ENG-123', host: 'acme.atlassian.net', key: 'ENG-123', number: 123 });
		expect(parseIssueUrl('https://jira.acme.dev/jira/browse/OPS_2-4')?.url).toBe('https://jira.acme.dev/jira/browse/OPS_2-4');
		expect(parseIssueUrl('https://acme.atlassian.net/browse/ENG-0')).toBeNull();
		expect(parseIssueUrl('https://user:pw@acme.atlassian.net/browse/ENG-1')).toBeNull();
	});

	test('Linear issues, with or without the title slug', () => {
		expect(parseIssueUrl('https://linear.app/acme/issue/eng-42/fix-the-login')).toEqual({ provider: 'linear', url: 'https://linear.app/acme/issue/ENG-42', key: 'ENG-42', number: 42 });
		expect(parseIssueUrl('https://linear.app/acme/project/x')).toBeNull();
	});

	test('a plain name, a sentence with a URL, or another site is not a link', () => {
		for (const text of ['', 'Fix the login page', 'see https://github.com/acme/app/issues/12', 'https://example.com/', 'ftp://github.com/a/b/issues/1', 'https://github.com/acme/app/issues/12 now'])
			expect([text, parseIssueUrl(text)]).toEqual([text, null]);
	});
});

test('issueUrlRef names the issue per tracker', () => {
	expect(issueUrlRef(parseIssueUrl('https://github.com/acme/app/issues/12')!)).toBe('acme/app#12');
	expect(issueUrlRef(parseIssueUrl('https://gitlab.com/g/app/-/issues/5')!)).toBe('g/app#5');
	expect(issueUrlRef(parseIssueUrl('https://acme.atlassian.net/browse/ENG-1')!)).toBe('ENG-1');
});

test('siteHost reads a host or a URL', () => {
	expect(siteHost('acme.atlassian.net')).toBe('acme.atlassian.net');
	expect(siteHost(' https://Jira.acme.dev/jira/ ')).toBe('jira.acme.dev');
	expect(siteHost('')).toBe('');
});

test('titleAfterLink replaces only an empty field or the pasted URL', () => {
	const url = 'https://github.com/acme/app/issues/12';
	expect(titleAfterLink(url, url, 'Fix login')).toBe('Fix login');
	expect(titleAfterLink('  ', url, 'Fix login')).toBe('Fix login');
	expect(titleAfterLink('My own name', url, 'Fix login')).toBe('My own name');
});
