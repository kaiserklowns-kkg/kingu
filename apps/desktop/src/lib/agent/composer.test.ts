import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import {
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
	slashMenu,
	slashSections,
	chromeKey,
	commandNames,
	shellTokens,
	skippedName,
	skippedText,
	stopKey
} from './composer.ts';
import { filterRows, initialActive, nextEnabled, placeMenu, startsSection, type MenuRow } from './composerMenu.ts';
import { DRILL_SOURCES, filterScoped, planMentions } from './chatContext.ts';
import { modeCommands, type SlashItem } from './slashCommands.ts';
import { activityEnd, bashDescription, editSnippet, foldSteps, hiddenTools, splitVerb, workedFor } from './chatParts.ts';

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

	test('⌘. / ⇧Tab cycle in the menu order Agent → Plan → Ask → custom agents and wrap', () => {
		const order = modeOrder(['reviewer']);
		expect(order).toEqual(['agent', 'plan', 'ask', 'custom:reviewer']);
		expect(cycleMode(order, 'agent')).toBe('plan');
		expect(cycleMode(order, 'ask')).toBe('custom:reviewer');
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
	test('one line for every mode; state rules first', () => {
		expect(composerPlaceholder({ folder: false, running: true })).toBe('Open a folder to chat with the agent');
		expect(composerPlaceholder({ folder: true, editingQueued: true, pendingApproval: true })).toBe('Editing queued message…');
		expect(composerPlaceholder({ folder: true, pendingApproval: true, running: true })).toBe('Reject, suggest, follow up?');
		expect(composerPlaceholder({ folder: true, running: true })).toBe('Add a follow-up');
		expect(composerPlaceholder({ folder: true, followUp: true })).toBe('Add a follow-up');
		expect(composerPlaceholder({ folder: true })).toBe('Plan, Build, / for skills, @ for context');
		expect(composerPlaceholder({ folder: true, agent: 'Arkai' })).toBe('Chat with Arkai');
		expect(composerPlaceholder({ folder: true, agent: 'Arkai', followUp: true, running: true })).toBe('Chat with Arkai');
		expect(composerPlaceholder({ folder: true, agent: 'Arkai', pendingApproval: true })).toBe('Reject, suggest, follow up?');
		expect(composerPlaceholder({ folder: false, agent: 'Arkai' })).toBe('Open a folder to chat with the agent');
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

test('the @ menu: the current file first, then the sources in Cursor\'s order; typed: sources, folders, files; drilled lists', () => {
	const label = (s: string) => s;
	const base = { active: 'app.ts', recent: ['a.ts', 'app.ts', 'b.ts', 'c.ts'], ranked: ['src/x.ts'], folders: ['src', 'docs'], attached: ['b.ts'], label };
	const empty = planMentions({ ...base, query: '', scope: null });
	expect(empty.current).toEqual(['app.ts', 'a.ts', 'c.ts']);
	expect(empty.sources.slice(0, 4)).toEqual(['files', 'terminal', 'pastChat', 'scm']);
	expect(empty.files).toEqual([]);
	expect(planMentions({ ...base, active: 'b.ts', query: '', scope: null }).current[0]).toBe('a.ts');
	expect(DRILL_SOURCES).toEqual({ files: 'files', terminal: 'terminals', pastChat: 'chats' });
	const typed = planMentions({ ...base, query: 'src', scope: null });
	expect(typed.current).toEqual([]);
	expect(typed.folders).toEqual(['src']);
	expect(typed.files).toEqual(['src/x.ts']);
	expect(planMentions({ ...base, query: 'term', scope: null }).sources).toEqual(['terminal']);
	const files = planMentions({ ...base, query: '', scope: 'files' });
	expect(files.sources).toEqual([]);
	expect(files.files).toEqual(['src/x.ts']);
	expect(planMentions({ ...base, query: '', scope: 'chats' })).toEqual({ current: [], sources: [], folders: [], files: [] });
	expect(filterScoped([{ label: 'zsh' }, { label: 'node dev' }], 'NODE')).toEqual([{ label: 'node dev' }]);
});

test('the / menu folds Skills to 3 with "Show N more" while nothing is typed', () => {
	const item = (name: string, source: SlashItem['source']): SlashItem => ({ name, description: '', argumentHint: '', source });
	const items = [item('s1', 'user-skill'), item('s2', 'user-skill'), item('s3', 'project-skill'), item('s4', 'user-skill'), item('s5', 'user-skill'), item('review', 'session')];
	const folded = slashMenu(items, { query: '', expanded: false });
	expect(folded.map((e) => (e.kind === 'more' ? `more:${e.count}` : e.item.name))).toEqual(['s1', 's2', 's3', 'more:2', 'review']);
	expect(slashMenu(items, { query: '', expanded: true }).length).toBe(6);
	expect(slashMenu(items, { query: 's', expanded: false }).some((e) => e.kind === 'more')).toBe(false);
	// One hidden row is not worth a "Show 1 more".
	expect(slashMenu(items.slice(2), { query: '', expanded: false }).some((e) => e.kind === 'more')).toBe(false);
});

test('keys on the composer\'s own buttons: ⇧Tab cycles, a typed @ goes to the text (not the focused button)', () => {
	expect(chromeKey(key('Tab', { shiftKey: true }))).toBe('cycle');
	expect(chromeKey(key('@', { shiftKey: true }))).toBe('type');
	expect(chromeKey(key('a'))).toBe('type');
	expect(chromeKey(key(' '))).toBeNull();
	expect(chromeKey(key('Enter'))).toBeNull();
	expect(chromeKey(key('a', { metaKey: true }))).toBeNull();
	expect(chromeKey(key('@', { isComposing: true }))).toBeNull();
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

test('transcript look: edit snippets, bold verbs, Worked for, folded steps', () => {
	expect(editSnippet('Edit', { old_string: 'a\nb\nc', new_string: 'a\nb\nX\nc' })).toEqual([
		{ sign: ' ', text: 'b' },
		{ sign: '+', text: 'X' }
	]);
	expect(editSnippet('Edit', { old_string: 'one', new_string: 'two' })).toEqual([
		{ sign: '-', text: 'one' },
		{ sign: '+', text: 'two' }
	]);
	expect(editSnippet('Write', { content: '1\n2\n3\n4\n5\n6\n7' }, 3).map((l) => l.text)).toEqual(['1', '2', '3']);
	expect(editSnippet('MultiEdit', { edits: [{ old_string: 'x', new_string: 'y' }] }).length).toBe(2);
	expect(editSnippet('Read', {})).toEqual([]);
	expect(splitVerb('Read src/app.ts')).toEqual({ verb: 'Read', rest: 'src/app.ts' });
	expect(splitVerb('Thought')).toEqual({ verb: 'Thought', rest: '' });
	expect(bashDescription({ command: 'git status', description: 'Show git working tree status' })).toBe('Show git working tree status');
	expect(bashDescription({ command: 'ls' })).toBeNull();
	expect(workedFor(2000)).toBe('2s');
	expect(workedFor(200)).toBe('1s');
	expect(workedFor(65000)).toBe('1m 5s');
	expect(workedFor(null)).toBeNull();
	expect(activityEnd([{ kind: 'thinking' }, { kind: 'tool' }, { kind: 'markdown' }])).toBe(2);
	expect(activityEnd([{ kind: 'markdown' }])).toBe(0);
	expect(activityEnd([{ kind: 'tool' }])).toBe(1);
});

test('the approval card: shell colours and command names', () => {
	const cmd = 'echo approval-test > probe2.txt && cat probe2.txt | FOO=1 wc -l "a b"';
	const toks = shellTokens(cmd);
	expect(toks.map((x) => x.text).join('')).toBe(cmd);
	expect(toks.filter((x) => x.kind === 'cmd').map((x) => x.text)).toEqual(['echo', 'cat', 'wc']);
	expect(toks.filter((x) => x.kind === 'op').map((x) => x.text)).toEqual(['>', '&&', '|']);
	expect(toks.find((x) => x.kind === 'str')?.text).toBe('"a b"');
	expect(toks.find((x) => x.text === 'probe2.txt')?.kind).toBe('arg');
	expect(commandNames('echo hi && cat x; /bin/echo again')).toEqual(['echo', 'cat']);
	expect(skippedName('Bash', { command: 'rm -f probe2.txt' })).toBe('rm');
	expect(skippedName('Edit', { file_path: 'a.ts' })).toBe('Edit');
});

test('"Worked for" folds only a finished request\'s steps before its answer', () => {
	const steps = [{ kind: 'thinking' }, { kind: 'tool' }, { kind: 'markdown' }];
	expect(foldSteps({ request: {}, done: true, parts: steps })).toBe(2);
	expect(foldSteps({ request: {}, done: false, parts: steps })).toBe(0);
	expect(foldSteps({ request: null, done: true, parts: steps })).toBe(0);
	expect(foldSteps({ request: {}, done: true, parts: [{ kind: 'markdown' }] })).toBe(0);
	// A turn a steered message closed before any answer folds all its steps.
	expect(foldSteps({ request: {}, done: true, parts: [{ kind: 'tool' }, { kind: 'tool' }] })).toBe(2);
	// Text between steps folds too; a skipped call after the answer stays in view.
	expect(foldSteps({ request: {}, done: true, parts: [{ kind: 'tool' }, { kind: 'markdown' }, { kind: 'tool' }, { kind: 'markdown' }, { kind: 'confirmation' }] })).toBe(3);
	expect(foldSteps({ request: {}, done: true, parts: [{ kind: 'tool' }, { kind: 'markdown' }, { kind: 'error' }] })).toBe(1);
});

test('a call waiting for approval or skipped is drawn only as its card or "Skipped" line', () => {
	const req = (id: string, tool = 'Bash') => ({ kind: 'confirmation' as const, request: { kind: 'permission_request' as const, request_id: id, tool, tool_use_id: `t-${id}`, title: null, input_summary: '', detail: null, diff: null, input: {}, can_always: false } });
	const parts = [req('a'), req('b'), req('c'), req('q', 'AskUserQuestion')];
	expect([...hiddenTools(parts, { b: 'deny', c: 'allow' })].sort()).toEqual(['t-a', 't-b']);
	expect(skippedText('Edit', { file_path: '/tmp/p/src/app.js' })).toBe('Skipped edit to app.js');
	expect(skippedText('Bash', { command: 'rm x' })).toBe('Skipped rm');
	expect(skippedText('WebFetch', {})).toBe('Skipped WebFetch');
});

test('composer dropdowns stay inside the chat panel', () => {
	const panel = { left: 1000, right: 1360, top: 0, bottom: 800 };
	const pill = { left: 1100, right: 1180, top: 700, bottom: 722 };
	const p = placeMenu(pill, panel, { width: 300, align: 'left', below: false });
	expect(p.left + p.width).toBeLessThanOrEqual(1356);
	expect(p.left).toBeGreaterThanOrEqual(1004);
	expect(p.bottom).toBe(800 - 700 + 6);
	const narrow = placeMenu(pill, { ...panel, left: 1100, right: 1300 }, { width: 300, align: 'left', below: true });
	expect(narrow.width).toBe(192);
	expect(narrow.left).toBe(1104);
	expect(narrow.top).toBe(728);
	const right = placeMenu({ left: 1300, right: 1350, top: 10, bottom: 30 }, panel, { width: 200, align: 'right', below: true });
	expect(right.left).toBe(1150);
});
