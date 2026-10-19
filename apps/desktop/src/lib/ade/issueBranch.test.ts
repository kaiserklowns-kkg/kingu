import { describe, expect, test } from 'bun:test';
import { issueBranchLeaf } from './issueBranch.ts';

const jira = (key: string) => ({ number: 0, url: '', title: '', provider: 'jira' as const, key });

describe('issueBranchLeaf', () => {
	test('keeps a Jira key uppercase in the branch', () => {
		expect(issueBranchLeaf('eng-123-fix-login', jira('ENG-123'))).toBe('ENG-123-fix-login');
		expect(issueBranchLeaf('eng-123-fix-login-2', jira('ENG-123'))).toBe('ENG-123-fix-login-2');
		expect(issueBranchLeaf('eng-123', jira('ENG-123'))).toBe('ENG-123');
		expect(issueBranchLeaf('my-proj-7-x', jira('MY_PROJ-7'))).toBe('MY_PROJ-7-x');
	});

	test('leaves every other branch to the slug', () => {
		expect(issueBranchLeaf('eng-1234-x', jira('ENG-123'))).toBeNull();
		expect(issueBranchLeaf('fix-login', jira('ENG-123'))).toBeNull();
		expect(issueBranchLeaf('eng-123-x', jira('eng-123'))).toBeNull();
		expect(issueBranchLeaf('eng-123-x', { number: 0, url: '', title: '', provider: 'linear', key: 'ENG-123' })).toBeNull();
		expect(issueBranchLeaf('issue-12-x', { number: 12, url: '', title: '' })).toBeNull();
		expect(issueBranchLeaf('x', undefined)).toBeNull();
	});
});
