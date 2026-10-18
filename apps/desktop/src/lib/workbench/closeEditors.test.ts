import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settleClose, type ClosePorts, type ConfirmResult } from './textFiles.ts';

function ports(o: { dirty?: string[]; elsewhere?: string[]; answer?: ConfirmResult; saveFails?: string[]; autoSave?: ClosePorts['autoSave'] } = {}) {
	const log: string[] = [];
	const p: ClosePorts = {
		isDirty: (path) => (o.dirty ?? []).includes(path),
		openElsewhere: (path) => (o.elsewhere ?? []).includes(path),
		autoSave: o.autoSave ?? 'off',
		isMac: true,
		save: async (path, reason) => (log.push(`save ${path}${reason ? ` ${reason}` : ''}`), !(o.saveFails ?? []).includes(path)),
		confirm: async (paths) => (log.push(`ask ${paths.join(',')}`), o.answer ?? 'cancel'),
		discardBackup: (path) => log.push(`discard ${path}`),
		reveal: (path) => log.push(`reveal ${path}`)
	};
	return { p, log };
}

test('a clean file, or one shown elsewhere, closes without a question', async () => {
	const { p, log } = ports({ dirty: ['b'], elsewhere: ['b'] });
	expect(await settleClose(['a', 'b'], p)).toEqual(['a', 'b']);
	expect(log).toEqual([]);
});

test('Save / Don’t Save / Cancel for the only view of unsaved edits', async () => {
	let t = ports({ dirty: ['a'], answer: 'save' });
	expect(await settleClose(['a'], t.p)).toEqual(['a']);
	expect(t.log).toEqual(['reveal a', 'ask a', 'save a']);

	t = ports({ dirty: ['a'], answer: 'dontSave' });
	expect(await settleClose(['a'], t.p)).toEqual(['a']);
	expect(t.log).toEqual(['reveal a', 'ask a', 'discard a']);

	t = ports({ dirty: ['a'], answer: 'cancel' });
	expect(await settleClose(['a'], t.p)).toEqual([]);

	// A failed save (a conflict, an unencodable character) keeps the editor open.
	t = ports({ dirty: ['a'], answer: 'save', saveFails: ['a'] });
	expect(await settleClose(['a'], t.p)).toEqual([]);
});

test('one dialog for several dirty files; ⌥-click discards without asking', async () => {
	let t = ports({ dirty: ['a', 'b'], answer: 'dontSave' });
	expect(await settleClose(['a', 'b', 'c'], t.p)).toEqual(['c', 'a', 'b']);
	expect(t.log).toEqual(['ask a,b', 'discard a', 'discard b']);

	t = ports({ dirty: ['a'] });
	expect(await settleClose(['a'], t.p, { discard: true })).toEqual(['a']);
	expect(t.log).toEqual(['discard a']);
});

test('auto save on focus change saves instead of asking', async () => {
	const t = ports({ dirty: ['a'], autoSave: 'onFocusChange' });
	expect(await settleClose(['a'], t.p)).toEqual(['a']);
	expect(t.log).toEqual(['save a focusChange']);
});

test('the Agents layout’s file tabs go through the IDE’s text file service', () => {
	const ade = (f: string) => readFileSync(join(import.meta.dir, '..', 'ade', f), 'utf8');
	const layout = ade('adeLayout.svelte.ts');
	expect(layout).toContain('textFiles.confirmClose(');
	const view = ade('AgentsLayout.svelte');
	expect(view).toContain('<FilePlaceholder');
	expect(view).toContain('textFiles.openFailed(');
	expect(view).toContain('<SaveConflictCompare');
	expect(view).not.toContain('เปิดไฟล์ไม่ได้');
});
