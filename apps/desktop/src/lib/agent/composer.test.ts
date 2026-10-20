import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import {
	allowlistLabel,
	approvalKey,
	browseHistory,
	canSteer,
	composerLayout,
	composerPlaceholder,
	customName,
	cycleMode,
	enterAction,
	modeCycleKey,
	modeOrder,
	modeTone,
	moveItem,
	NO_HISTORY,
	plainArrowBrowses,
	primaryAction,
	runModeLabel,
	shortModelLabel,
	slashSection,
	slashSections,
	stopKey
} from './composer.ts';
import { filterRows, initialActive, nextEnabled, startsSection, type MenuRow } from './composerMenu.ts';
import { planMentions } from './chatContext.ts';
import { modeCommands, type SlashItem } from './slashCommands.ts';

setLocale('en');

const key = (k: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; repeat: boolean; isComposing: boolean }> = {}) => ({
	key: k,
	shiftKey: false,
	altKey: false,
	metaKey: false,
	ctrlKey: false,
	...mods
});

describe('modes', () => {
	test('tones and custom names', () => {
		expect(modeTone('agent')).toBe('agent');
		expect(modeTone('ask')).toBe('ask');
		expect(modeTone('plan')).toBe('plan');
		expect(modeTone('custom:reviewer')).toBe('custom');
		expect(customName('custom:reviewer')).toBe('reviewer');
		expect(customName('agent')).toBeNull();
	});

	test('⌘. / ⇧Tab cycle Agent → Ask → Plan → custom agents and wrap', () => {
		const order = modeOrder(['reviewer']);
		expect(order).toEqual(['agent', 'ask', 'plan', 'custom:reviewer']);
		expect(cycleMode(order, 'agent')).toBe('ask');
		expect(cycleMode(order, 'plan')).toBe('custom:reviewer');
		expect(cycleMode(order, 'custom:reviewer')).toBe('agent');
		expect(cycleMode(order, 'agent', -1)).toBe('custom:reviewer');
		expect(cycleMode(order, 'custom:gone')).toBe('agent');
		expect(cycleMode([], 'plan')).toBe('plan');
	});

	test('run modes are named the Cursor way', () => {
		expect(runModeLabel('default')).toBe('Ask Every Time');
		expect(runModeLabel('acceptEdits')).toBe('Auto-Accept Edits');
		expect(runModeLabel('bypassPermissions')).toBe('Run Everything');
	});
});

describe('placeholder', () => {
	test('the first rule that applies wins', () => {
		expect(composerPlaceholder({ folder: false, running: true, mode: 'agent' })).toBe('Open a folder to chat with the agent');
		expect(composerPlaceholder({ folder: true, editingQueued: true, pendingApproval: true, mode: 'agent' })).toBe('Editing queued message…');
		expect(composerPlaceholder({ folder: true, pendingApproval: true, running: true, mode: 'agent' })).toBe('Reject, suggest, follow up?');
		expect(composerPlaceholder({ folder: true, running: true, mode: 'ask' })).toContain('Queue');
	});

	test('per mode, new chat and follow-up', () => {
		expect(composerPlaceholder({ folder: true, mode: 'agent' })).toBe('Plan, search, build anything');
		expect(composerPlaceholder({ folder: true, followUp: true, mode: 'agent' })).toBe('Add a follow-up');
		expect(composerPlaceholder({ folder: true, mode: 'ask' })).toBe('Ask, learn, brainstorm');
		expect(composerPlaceholder({ folder: true, mode: 'plan' })).toBe('Plan changes');
		expect(composerPlaceholder({ folder: true, mode: 'custom:reviewer' })).toBe('Message reviewer');
		expect(composerPlaceholder({ folder: true, followUp: true, mode: 'custom:reviewer' })).toBe('Add a follow-up for reviewer');
	});
});

describe('keys', () => {
	const mac = { cmdEnter: false, mac: true };
	test('Enter sends, ⇧Enter is a new line, ⌥ and ⌘ pick the other ways while a turn runs', () => {
		expect(enterAction(key('Enter'), mac)).toBe('submit');
		expect(enterAction(key('Enter', { shiftKey: true }), mac)).toBeNull();
		expect(enterAction(key('Enter', { altKey: true }), mac)).toBe('submitAlt');
		expect(enterAction(key('Enter', { metaKey: true }), mac)).toBe('submitStop');
		expect(enterAction(key('Enter', { ctrlKey: true }), mac)).toBeNull();
		expect(enterAction(key('Enter', { ctrlKey: true }), { cmdEnter: false, mac: false })).toBe('submitStop');
		expect(enterAction(key('Enter', { isComposing: true }), mac)).toBeNull();
		expect(enterAction(key('Enter', { repeat: true }), mac)).toBe('ignore');
		expect(enterAction(key('a'), mac)).toBeNull();
	});

	test('Submit with ⌘Enter: Enter adds a line, ⌘Enter sends, ⌘⌥Enter stops and sends', () => {
		const opts = { cmdEnter: true, mac: true };
		expect(enterAction(key('Enter'), opts)).toBeNull();
		expect(enterAction(key('Enter', { metaKey: true }), opts)).toBe('submit');
		expect(enterAction(key('Enter', { metaKey: true, altKey: true }), opts)).toBe('submitStop');
	});

	test('approval keys only with an empty input', () => {
		expect(approvalKey(key('Enter'), true)).toBe('allow');
		expect(approvalKey(key('Enter', { shiftKey: true }), true)).toBe('allowlist');
		expect(approvalKey(key('Escape'), true)).toBe('skip');
		expect(approvalKey(key('Enter'), false)).toBeNull();
		expect(approvalKey(key('Enter', { metaKey: true }), true)).toBeNull();
		expect(approvalKey(key('a'), true)).toBeNull();
	});

	test('mode cycling and stop', () => {
		expect(modeCycleKey(key('Tab', { shiftKey: true }), true)).toBe(true);
		expect(modeCycleKey(key('Tab'), true)).toBe(false);
		expect(modeCycleKey(key('.', { metaKey: true }), true)).toBe(true);
		expect(modeCycleKey(key('.', { ctrlKey: true }), false)).toBe(true);
		expect(modeCycleKey(key('.', { ctrlKey: true }), true)).toBe(false);
		expect(stopKey(key('Backspace', { metaKey: true, shiftKey: true }), true, false)).toBe(true);
		expect(stopKey(key('c', { ctrlKey: true }), true, false)).toBe(true);
		expect(stopKey(key('c', { ctrlKey: true }), true, true)).toBe(false);
		expect(stopKey(key('c', { ctrlKey: true }), false, false)).toBe(false);
		expect(stopKey(key('Backspace', { ctrlKey: true, shiftKey: true }), false, false)).toBe(true);
	});
});

test('the round button', () => {
	expect(primaryAction({ running: false, hasText: true, canStop: true })).toBe('send');
	expect(primaryAction({ running: false, hasText: false, canStop: true })).toBe('none');
	expect(primaryAction({ running: true, hasText: true, canStop: true })).toBe('queue');
	expect(primaryAction({ running: true, hasText: false, canStop: true })).toBe('stop');
	expect(primaryAction({ running: true, hasText: false, canStop: false })).toBe('none');
});

describe('⌥↑ / ⌥↓ history', () => {
	const history = ['one', 'two', 'three'];
	test('steps back from the newest and gives the draft back past it', () => {
		const a = browseHistory(history, NO_HISTORY, 'up', 'draft')!;
		expect(a.text).toBe('three');
		const b = browseHistory(history, a.nav, 'up', a.text)!;
		expect(b.text).toBe('two');
		const c = browseHistory(history, b.nav, 'down', b.text)!;
		expect(c.text).toBe('three');
		const d = browseHistory(history, c.nav, 'down', c.text)!;
		expect(d).toEqual({ nav: NO_HISTORY, text: 'draft' });
	});

	test('stops at the oldest; ↓ does nothing when not browsing; an edited entry starts over', () => {
		const first = { index: 0, draft: '' };
		expect(browseHistory(history, first, 'up', 'one')).toBeNull();
		expect(browseHistory(history, NO_HISTORY, 'down', 'x')).toBeNull();
		expect(browseHistory([], NO_HISTORY, 'up', '')).toBeNull();
		expect(browseHistory(history, { index: 1, draft: '' }, 'up', 'two edited')?.text).toBe('three');
	});

	test('plain arrows browse only from an empty input or while browsing, on the edge line', () => {
		expect(plainArrowBrowses('', NO_HISTORY, history, 'up', '', '')).toBe(true);
		expect(plainArrowBrowses('typed', NO_HISTORY, history, 'up', 'typed', '')).toBe(false);
		expect(plainArrowBrowses('two', { index: 1, draft: '' }, history, 'down', 'two', '')).toBe(true);
		expect(plainArrowBrowses('a\nb', { index: null, draft: '' }, history, 'up', 'a\nb', '')).toBe(false);
	});
});

test('the bottom bar drops labels as the composer narrows', () => {
	expect(composerLayout(500)).toEqual({ modeLabel: true, modelLabel: true, ring: true, optionsLabel: true });
	expect(composerLayout(320)).toEqual({ modeLabel: true, modelLabel: true, ring: true, optionsLabel: false });
	expect(composerLayout(280)).toEqual({ modeLabel: false, modelLabel: true, ring: true, optionsLabel: false });
	expect(composerLayout(250)).toEqual({ modeLabel: false, modelLabel: false, ring: false, optionsLabel: false });
	expect(composerLayout(0).modeLabel).toBe(true);
});

test('short labels', () => {
	expect(shortModelLabel('claude-opus-4-1-20250805')).toBe('opus-4-1');
	expect(shortModelLabel('Default (recommended)')).toBe('Default');
	expect(shortModelLabel('Sonnet 4.5 thinking')).toBe('Sonnet 4.5');
	expect(shortModelLabel('')).toBe('');
	expect(allowlistLabel(['Bash(npm test:*)'], 'Bash')).toBe('npm test *');
	expect(allowlistLabel(['Bash(git status)'], 'Bash')).toBe('git status');
	expect(allowlistLabel(['WebFetch'], 'WebFetch')).toBe('WebFetch');
	expect(allowlistLabel([], 'Edit')).toBe('Always allow Edit');
	expect(allowlistLabel(['Bash(a:*)', 'Bash(b:*)'], 'Bash')).toBe('Allowlist 2 rules');
});

test('the / menu: Skills, Commands, Modes, Actions', () => {
	const item = (name: string, source: SlashItem['source']): SlashItem => ({ name, description: '', argumentHint: '', source });
	expect(slashSection('project-skill')).toBe('skills');
	expect(slashSection('session')).toBe('commands');
	expect(slashSection('mode')).toBe('modes');
	expect(slashSection('kingu')).toBe('actions');
	const rows = slashSections([item('clear', 'kingu'), item('plan', 'mode'), item('review', 'session'), item('pdf', 'user-skill'), item('fix', 'prompt')]);
	expect(rows.map((r) => [r.name, r.section, r.first])).toEqual([
		['pdf', 'skills', true],
		['review', 'commands', true],
		['fix', 'commands', false],
		['plan', 'modes', true],
		['clear', 'actions', true]
	]);
	const modes = modeCommands([{ name: 'plan', label: 'Switch to Plan', run: () => {} }]);
	expect(modes[0]).toMatchObject({ name: 'plan', source: 'mode', description: 'Switch to Plan' });
});

test('the @ menu: recents then sources; typed: sources, folders, files; Files & Folders drilled into', () => {
	const label = (s: string) => s;
	const base = { recent: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], ranked: ['src/x.ts'], folders: ['src', 'docs'], attached: ['b.ts'], label };
	const empty = planMentions({ ...base, query: '', scope: null });
	expect(empty.recent).toEqual(['a.ts', 'c.ts', 'd.ts']);
	expect(empty.sources[0]).toBe('files');
	expect(empty.files).toEqual([]);
	const typed = planMentions({ ...base, query: 'src', scope: null });
	expect(typed.recent).toEqual([]);
	expect(typed.folders).toEqual(['src']);
	expect(typed.files).toEqual(['src/x.ts']);
	const files = planMentions({ ...base, query: '', scope: 'files' });
	expect(files.sources).toEqual([]);
	expect(files.files).toEqual(['src/x.ts']);
});

test('queue order', () => {
	expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
	expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
	expect(moveItem(['a', 'b', 'c'], 1, 9)).toEqual(['a', 'c', 'b']);
	expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
	expect(canSteer('claude')).toBe(true);
	expect(canSteer(null)).toBe(true);
	expect(canSteer('acp')).toBe(false);
});

test('composer menus', () => {
	const rows: MenuRow[] = [
		{ id: 'agent', label: 'Agent', checked: false },
		{ id: 'ask', label: 'Ask', description: 'answers questions', checked: true },
		{ id: 'x', label: 'Reviewer', section: 'Custom agents', disabled: true },
		{ id: 'y', label: 'Writer', section: 'Custom agents' }
	];
	expect(filterRows(rows, 'answ').map((r) => r.id)).toEqual(['ask']);
	expect(filterRows(rows, '').length).toBe(4);
	expect(startsSection(rows, 2)).toBe(true);
	expect(startsSection(rows, 3)).toBe(false);
	expect(initialActive(rows)).toBe(1);
	expect(nextEnabled(rows, 1, 1)).toBe(3);
	expect(nextEnabled(rows, 3, 1)).toBe(0);
	expect(nextEnabled([{ id: 'a', label: 'a', disabled: true }], 0, 1)).toBe(-1);
});
