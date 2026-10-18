import { describe, expect, test } from 'bun:test';
import { branchTitle, humanizeBranchSlug, prefillPr, prFormProblem, prSubmitLabel } from './prForm';

const meta = { slug: 'fix-login', title: 'แก้หน้า login', prompt: 'แก้ปุ่ม login ที่กดไม่ได้', base: 'main', issue: null };

describe('prefill', () => {
	test('one commit: its subject and body', () => {
		const f = prefillPr(meta, 'kingu/fix-login', [{ subject: 'Fix login button', body: 'Bind the click handler.' }], false);
		expect(f).toEqual({ title: 'Fix login button', body: 'Bind the click handler.\n\n---\nสร้างจากงาน Kingu `fix-login`', base: 'main', draft: false });
	});

	test('several commits: the task name and prompt; an issue adds Fixes #N', () => {
		const commits = [
			{ subject: 'a', body: '' },
			{ subject: 'b', body: '' }
		];
		const f = prefillPr({ ...meta, issue: { number: 42, url: 'https://github.com/a/b/issues/42', title: 'login' } }, 'kingu/fix-login', commits, true);
		expect(f.title).toBe('แก้หน้า login');
		expect(f.body).toBe('Fixes #42\n\nแก้ปุ่ม login ที่กดไม่ได้\n\n---\nสร้างจากงาน Kingu `fix-login`');
		expect(f.draft).toBe(true);
	});

	test('an adopted worktree (name = slug) falls back to the branch, humanized (Orca)', () => {
		expect(prefillPr({ ...meta, title: 'fix-login' }, 'kingu/fix_login-page', [], false).title).toBe('Fix login page');
		expect(humanizeBranchSlug('--')).toBe('');
		expect(branchTitle('kingu/')).toBe('kingu/');
	});
});

describe('validation', () => {
	test('title, base, and base different from the branch', () => {
		expect(prFormProblem({ title: ' ', base: 'main' }, 'kingu/x')).toBe('ใส่ชื่อ PR');
		expect(prFormProblem({ title: 't', base: '' }, 'kingu/x')).toBe('เลือก base branch');
		expect(prFormProblem({ title: 't', base: 'Kingu/X' }, 'kingu/x')).toBe('base ต้องไม่ใช่ branch ของงานเอง');
		expect(prFormProblem({ title: 't', base: 'main' }, 'kingu/x')).toBeNull();
	});
	test('button label', () => {
		expect(prSubmitLabel(true, false)).toBe('Push และสร้าง draft PR');
		expect(prSubmitLabel(false, true)).toBe('กำลังสร้าง…');
	});
});
