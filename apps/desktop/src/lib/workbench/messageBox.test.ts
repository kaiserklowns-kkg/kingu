import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messageBoxRequest } from './messageBox.ts';

test('the cancel button is the Escape answer (last button unless given)', () => {
	expect(messageBoxRequest('m', { buttons: ['บันทึก (Save)', 'ไม่บันทึก (Don’t Save)', 'ยกเลิก (Cancel)'], dontSaveId: 1 })).toEqual({
		title: 'Kingu',
		message: 'm',
		kind: 'info',
		buttons: ['บันทึก (Save)', 'ไม่บันทึก (Don’t Save)', 'ยกเลิก (Cancel)'],
		cancelId: 2,
		dontSaveId: 1
	});
	expect(messageBoxRequest('m', { title: 't', kind: 'error', buttons: ['OK', 'ออกอยู่ดี'], cancelId: 0 })).toMatchObject({ cancelId: 0, dontSaveId: null, kind: 'error' });
});

test('no question uses the dialog plugin directly (its macOS alerts ignore Escape)', () => {
	const root = join(import.meta.dir, '..', '..');
	const offenders: string[] = [];
	for (const file of new Glob('**/*.{ts,svelte}').scanSync(root)) {
		const text = readFileSync(join(root, file), 'utf8');
		for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@tauri-apps\/plugin-dialog'/g)) {
			const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]);
			if (names.some((n) => n === 'ask' || n === 'message' || n === 'confirm')) offenders.push(file);
		}
	}
	expect(offenders).toEqual([]);
});
