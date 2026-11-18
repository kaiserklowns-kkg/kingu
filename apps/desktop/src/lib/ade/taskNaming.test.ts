import { describe, expect, test } from 'bun:test';
import { MARINE_CREATURES, creatureNameAtTier, splitBranchOverride, suggestCreatureName, taskName } from './taskNaming';

describe('MARINE_CREATURES', () => {
	test("Orca's list: 552 single words, none twice", () => {
		expect(MARINE_CREATURES.length).toBe(552);
		expect(new Set(MARINE_CREATURES.map((n) => n.toLowerCase())).size).toBe(552);
		expect(MARINE_CREATURES.every((n) => /^[A-Za-z]+$/.test(n))).toBe(true);
		expect(MARINE_CREATURES.slice(0, 3)).toEqual(['Nautilus', 'Seahorse', 'Starfish']);
	});
});

describe('suggestCreatureName', () => {
	test('a lowercased name, picked by the random number', () => {
		expect(suggestCreatureName([], () => 0)).toBe('nautilus');
		expect(suggestCreatureName([], () => 0.9999)).toBe(MARINE_CREATURES[551].toLowerCase());
	});

	test('skips names in use, whatever their case', () => {
		expect(suggestCreatureName(['Nautilus', ' SEAHORSE '], () => 0)).toBe('starfish');
	});

	test('every name taken: the next tier, name-2 then name-3', () => {
		const all = MARINE_CREATURES.map((n) => n.toLowerCase());
		expect(suggestCreatureName(all, () => 0)).toBe('nautilus-2');
		expect(suggestCreatureName([...all, 'nautilus-2'], () => 0)).toBe('seahorse-2');
		expect(suggestCreatureName([...all, ...all.map((n) => creatureNameAtTier(n, 2))], () => 0)).toBe('nautilus-3');
	});

	test('a tier with free names is used before the next one', () => {
		const all = MARINE_CREATURES.map((n) => n.toLowerCase());
		expect(suggestCreatureName(all.slice(1), () => 0.5)).toBe('nautilus');
	});
});

describe('taskName', () => {
	test('the typed name wins', () => {
		expect(taskName('  Fix login  ', 'do it', 'coral')).toEqual({ title: 'Fix login', generated: false });
	});

	test("no name: the prompt's first line", () => {
		expect(taskName(' ', '\nFix the login page\nand the footer', 'coral')).toEqual({ title: 'Fix the login page', generated: false });
		expect(taskName('', 'x'.repeat(200), 'coral').title).toBe('x'.repeat(80));
	});

	test('no name and nothing a branch name can keep: the creature', () => {
		expect(taskName('', '', 'coral')).toEqual({ title: 'coral', generated: true });
		expect(taskName('', 'แก้หน้าเข้าสู่ระบบ', 'coral')).toEqual({ title: 'coral', generated: true });
		expect(taskName('', '🎉 !!!', 'coral')).toEqual({ title: 'coral', generated: true });
	});
});

describe('splitBranchOverride', () => {
	test('the whole branch name, split at the last slash', () => {
		expect(splitBranchOverride(' feature/my-branch ')).toEqual({ prefix: 'feature/', leaf: 'my-branch' });
		expect(splitBranchOverride('my_branch')).toEqual({ prefix: '', leaf: 'my_branch' });
		expect(splitBranchOverride('team/bright/ENG-12-fix')).toEqual({ prefix: 'team/bright/', leaf: 'ENG-12-fix' });
		expect(splitBranchOverride('release-1.2/fix')).toEqual({ prefix: 'release-1.2/', leaf: 'fix' });
	});

	test("refuses what Rust's leaf and prefix rules refuse", () => {
		for (const bad of ['', '  ', '-x', 'feature/', 'feature/-x', 'feature/_x', 'a/x-', 'a/x--y', 'a/v1.2', 'a b', 'a//b', '/a', '.a/b', 'a/../b', 'a/.b/c', 'ชื่อ', `a/${'x'.repeat(49)}`, `${'p'.repeat(64)}/x`])
			expect(splitBranchOverride(bad)).toBeNull();
		expect(splitBranchOverride(`a/${'x'.repeat(48)}`)).not.toBeNull();
	});
});
