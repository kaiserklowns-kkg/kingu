import { describe, expect, test } from 'bun:test';
import { getNewestWorkspaceCleanupDiffCommentAt, shortWorkspaceCleanupBranchName } from './workspaceCleanupCandidateFields';
import {
	WORKSPACE_CLEANUP_REPORT_ROW_LIMIT,
	WORKSPACE_CLEANUP_REPORT_RUN_LIMIT,
	WORKSPACE_CLEANUP_ROW_IGNORED_FILE_LIMIT,
	WORKSPACE_CLEANUP_UNWATCHED_CAUSES
} from './workspaceCleanupRun';

describe('workspace cleanup candidate fields', () => {
	test('short branch drops refs/heads and falls back to HEAD', () => {
		expect(shortWorkspaceCleanupBranchName('refs/heads/feat/x')).toBe('feat/x');
		expect(shortWorkspaceCleanupBranchName('feat/x')).toBe('feat/x');
		expect(shortWorkspaceCleanupBranchName('')).toBe('HEAD');
	});

	test('newest diff comment ignores missing timestamps', () => {
		expect(getNewestWorkspaceCleanupDiffCommentAt()).toBeNull();
		expect(getNewestWorkspaceCleanupDiffCommentAt([])).toBeNull();
		expect(getNewestWorkspaceCleanupDiffCommentAt([{}, { createdAt: 5 }, { createdAt: 3 }])).toBe(5);
		expect(getNewestWorkspaceCleanupDiffCommentAt([{ createdAt: 9 }, {}])).toBe(9);
	});
});

describe('workspace cleanup run limits', () => {
	test('only unwatched causes are excluded from receipts', () => {
		expect(WORKSPACE_CLEANUP_UNWATCHED_CAUSES.has('not-removable')).toBe(true);
		expect(WORKSPACE_CLEANUP_UNWATCHED_CAUSES.has('project-off')).toBe(true);
		expect(WORKSPACE_CLEANUP_UNWATCHED_CAUSES.has('rules-off')).toBe(true);
		expect(WORKSPACE_CLEANUP_UNWATCHED_CAUSES.has('waiting')).toBe(false);
		expect(WORKSPACE_CLEANUP_REPORT_RUN_LIMIT).toBe(20);
		expect(WORKSPACE_CLEANUP_REPORT_ROW_LIMIT).toBe(200);
		expect(WORKSPACE_CLEANUP_ROW_IGNORED_FILE_LIMIT).toBe(3);
	});
});
