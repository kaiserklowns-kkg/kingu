/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { homeChats, OTHER_ENTRIES, savedStatus, shuffled, watermarkEntries, type LiveHomeChat, type SavedHomeChat } from './home';

const saved = (root: string, id: string, at: number, extra: Partial<SavedHomeChat> = {}): SavedHomeChat => ({ root, id, title: id, runtime: 'claude', agent: null, created_at: 1, updated_at: at, status: 'done', working: false, ...extra });
const live = (id: string, at: number, status: LiveHomeChat['status'] = 'idle'): LiveHomeChat => ({ id, title: id, agentName: 'Claude', at, status });
const names = (id: string) => ({ claude: 'Claude', arkai: 'Arkai' })[id] ?? id;

describe('Continue', () => {
	test('the open folder live in place of its saved copy, other folders as saved, newest first', () => {
		const rows = homeChats('/a', [live('a1', 50)], [saved('/a', 'a1', 10), saved('/a', 'stale', 99), saved('/b', 'b1', 70, { runtime: 'arkai' }), saved('/c', 'c1', 20)], names);
		expect(rows.map((r) => `${r.root}:${r.id}`)).toEqual(['/b:b1', '/a:a1', '/c:c1']);
		expect(rows[0].agentName).toBe('Arkai');
	});

	test('chats an agent works on or waits in come first, then at most `max`', () => {
		const rows = homeChats('/a', [live('old', 1, 'needsInput'), live('new', 9)], [saved('/b', 'run', 2, { working: true }), saved('/b', 'x', 5), saved('/b', 'y', 4)], names, 4);
		expect(rows.map((r) => r.id)).toEqual(['run', 'old', 'new', 'x']);
	});

	test('with no live list (no folder, or not loaded yet) every folder reads as saved', () => {
		expect(homeChats(null, [], [saved('/a', 'a1', 3, { agent: 'ask' })], names)).toEqual([{ root: '/a', id: 'a1', title: 'a1', agentName: 'ask', at: 3, status: 'idle' }]);
	});

	test('a saved chat with no update time sorts by when it was made', () => {
		expect(homeChats(null, [], [saved('/a', 'a', 0, { created_at: 7 })], names)[0].at).toBe(7);
	});

	test('saved status', () => {
		expect(savedStatus({ status: 'failed', working: false })).toBe('failed');
		expect(savedStatus({ status: 'waiting', working: false })).toBe('needsInput');
		expect(savedStatus({ status: 'done', working: true })).toBe('working');
		expect(savedStatus({ status: null, working: false })).toBe('idle');
	});
});

describe('watermark shortcuts', () => {
	const keys: Record<string, string> = {
		'workbench.action.chat.open': 'ctrl+cmd+i',
		'workbench.action.showCommands': 'cmd+shift+p',
		'workbench.action.openRecent': 'ctrl+r',
		'workbench.action.files.openFolder': 'cmd+o',
		'workbench.action.files.newUntitledFile': 'cmd+n',
		'workbench.action.quickOpen': 'cmd+p',
		'workbench.action.findInFiles': 'cmd+shift+f'
	};
	const keyFor = (id: string) => keys[id];

	test('no folder on macOS: the five of kingu-old, Open Folder standing in for Open File or Folder', () => {
		expect(watermarkEntries(false, true, keyFor).map((e) => [e.label, e.key])).toEqual([
			['home.shortcut.openChat', 'ctrl+cmd+i'],
			['home.shortcut.showCommands', 'cmd+shift+p'],
			['home.shortcut.openRecent', 'ctrl+r'],
			['home.shortcut.openFolder', 'cmd+o'],
			['home.shortcut.newUntitledFile', 'cmd+n']
		]);
		const withFileFolder = (id: string) => (id === 'workbench.action.files.openFileFolder' ? 'cmd+o' : keyFor(id));
		expect(watermarkEntries(false, true, withFileFolder)[3].label).toBe('home.shortcut.openFileFolder');
	});

	test('no folder elsewhere: Open File and Open Folder, unbound ones left out', () => {
		expect(watermarkEntries(false, false, keyFor).map((e) => e.id)).toEqual(['workbench.action.chat.open', 'workbench.action.showCommands', 'workbench.action.openRecent', 'workbench.action.files.openFolder']);
	});

	test('a folder: Open Chat and Show All Commands, filled up to three from the other list', () => {
		expect(watermarkEntries(true, true, keyFor).map((e) => e.id)).toEqual(['workbench.action.chat.open', 'workbench.action.showCommands', 'workbench.action.quickOpen']);
		const other = [...OTHER_ENTRIES].reverse();
		expect(watermarkEntries(true, true, keyFor, other)[2].id).toBe('workbench.action.findInFiles');
		const noChat = (id: string) => (id === 'workbench.action.chat.open' ? undefined : keyFor(id));
		expect(watermarkEntries(true, true, noChat).map((e) => e.id)).toEqual(['workbench.action.showCommands', 'workbench.action.quickOpen', 'workbench.action.findInFiles']);
	});

	test('shuffled keeps every entry', () => {
		const list = [1, 2, 3, 4, 5];
		expect(shuffled(list, () => 0)).toEqual([2, 3, 4, 5, 1]);
		expect([...shuffled(list)].sort()).toEqual(list);
	});
});
