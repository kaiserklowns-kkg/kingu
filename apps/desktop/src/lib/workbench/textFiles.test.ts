import { describe, expect, test } from 'bun:test';
import {
	associationKey,
	backsUpOnShutdown,
	backupDelay,
	closeAction,
	confirmResult,
	diskChangeAction,
	encodingLabel,
	encodingPicks,
	ENCODINGS,
	fileNamesMessage,
	formatSize,
	indentLabel,
	isLargeModel,
	restorePlan,
	saveConfirm,
	tabSizePicks,
	type HotExit
} from './textFiles';

describe('save confirmation dialog (showSaveConfirm)', () => {
	test('one file: Save / Don’t Save / Cancel', () => {
		const c = saveConfirm(['a.ts']);
		expect(c.message).toContain('Do you want to save the changes you made to a.ts?');
		expect(c.detail).toContain('Your changes will be lost if you don’t save them.');
		expect(c.save).toContain('Save');
		expect(c.save).not.toContain('Save All');
	});

	test('several files: Save All and the file list, capped at 10', () => {
		const names = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
		const c = saveConfirm(names);
		expect(c.message).toContain('the following 12 files');
		expect(c.save).toContain('Save All');
		expect(c.detail.split('\n').slice(0, 11)).toEqual([...names.slice(0, 10), '...2 additional files not shown']);
		expect(fileNamesMessage(['a', 'b'])).toBe('a\nb\n');
		expect(fileNamesMessage(Array.from({ length: 11 }, () => 'x'))).toContain('...1 additional file not shown');
	});

	test('the pressed button maps to a choice (custom labels or Tauri defaults)', () => {
		const c = saveConfirm(['a', 'b']);
		expect(confirmResult(c.save, c)).toBe('save');
		expect(confirmResult(c.dontSave, c)).toBe('dontSave');
		expect(confirmResult(c.cancel, c)).toBe('cancel');
		expect(confirmResult('Yes', c)).toBe('save');
		expect(confirmResult('No', c)).toBe('dontSave');
		expect(confirmResult('Cancel', c)).toBe('cancel');
		// Closing the dialog any other way cancels.
		expect(confirmResult('', c)).toBe('cancel');
	});
});

describe('closing a dirty editor (handleDirtyClosing)', () => {
	const base = { dirty: true, openElsewhere: false, autoSave: 'off' as const, isMac: true };
	test('asks only for a dirty editor that is not open anywhere else', () => {
		expect(closeAction(base)).toBe('ask');
		expect(closeAction({ ...base, dirty: false })).toBe('close');
		expect(closeAction({ ...base, openElsewhere: true })).toBe('close');
	});
	test('auto save on focus/window change saves instead of opening a dialog', () => {
		expect(closeAction({ ...base, autoSave: 'onFocusChange' })).toBe('save');
		expect(closeAction({ ...base, autoSave: 'onWindowChange', isMac: false })).toBe('save');
		// On macOS a native dialog does not change window focus, so VS Code still asks.
		expect(closeAction({ ...base, autoSave: 'onWindowChange', isMac: true })).toBe('ask');
		expect(closeAction({ ...base, autoSave: 'afterDelay' })).toBe('ask');
	});
});

describe('hot exit (shouldBackupBeforeShutdown)', () => {
	const plan = (reason: 'quit' | 'close' | 'load' | 'reload', hotExit: HotExit, o: { hasFolder?: boolean; isMac?: boolean } = {}) =>
		backsUpOnShutdown({ reason, hotExit, hasFolder: o.hasFolder ?? true, isMac: o.isMac ?? true });
	test('off always asks', () => {
		for (const r of ['quit', 'close', 'load', 'reload'] as const) expect(plan(r, 'off')).toBe(false);
	});
	test('onExit backs up on quit and reload, asks on a macOS window close and on folder change', () => {
		expect(plan('quit', 'onExit')).toBe(true);
		expect(plan('reload', 'onExit')).toBe(true);
		expect(plan('close', 'onExit', { isMac: true })).toBe(false);
		expect(plan('close', 'onExit', { isMac: false })).toBe(true);
		expect(plan('load', 'onExit')).toBe(false);
	});
	test('onExitAndWindowClose also backs up window close and folder change with a folder open', () => {
		expect(plan('close', 'onExitAndWindowClose')).toBe(true);
		expect(plan('load', 'onExitAndWindowClose')).toBe(true);
		expect(plan('load', 'onExitAndWindowClose', { hasFolder: false })).toBe(false);
		expect(plan('close', 'onExitAndWindowClose', { hasFolder: false, isMac: true })).toBe(false);
	});
	test('backups wait longer when auto save is about to save anyway', () => {
		expect(backupDelay('off', 1000)).toBe(1000);
		expect(backupDelay('afterDelay', 1000)).toBe(2000);
		expect(backupDelay('afterDelay', 5000)).toBe(1000);
	});
});

describe('backup restore', () => {
	test('every backup is restored; the ones without a tab open in key order', () => {
		const backups = [
			{ key: 'src/b.ts', meta: { encoding: 'utf8' } },
			{ key: 'a.txt', meta: null },
			{ key: 'src/b.ts', meta: null }
		];
		expect(restorePlan(backups, new Set(['a.txt']))).toEqual({ open: ['src/b.ts'], restore: ['a.txt', 'src/b.ts'] });
		expect(restorePlan([], new Set())).toEqual({ open: [], restore: [] });
	});
});

describe('encodings and status bar items', () => {
	test('labels', () => {
		expect(encodingLabel('utf8')).toBe('UTF-8');
		expect(encodingLabel('utf8bom')).toBe('UTF-8 with BOM');
		expect(encodingLabel('windows874')).toBe('Windows 874');
		expect(encodingLabel('unknown')).toBe('unknown');
	});
	test('picker order: configured first, guessed on top when different', () => {
		const picks = encodingPicks('utf8', 'windows874');
		expect(picks[0]).toEqual({ id: 'windows874', label: 'Thai (Windows 874)', description: 'Guessed from content' });
		expect(picks[1].id).toBe('utf8');
		expect(picks.filter((p) => p.id === 'windows874')).toHaveLength(1);
		expect(encodingPicks('shiftjis')[0].id).toBe('shiftjis');
		expect(encodingPicks('utf8', 'utf8').length).toBe(Object.keys(ENCODINGS).length);
	});
	test('indentation label', () => {
		expect(indentLabel({ insertSpaces: true, tabSize: 4, indentSize: 4 })).toBe('Spaces: 4');
		expect(indentLabel({ insertSpaces: true, tabSize: 4, indentSize: 2 })).toBe('Spaces: 2 (4 wide tabs)');
		expect(indentLabel({ insertSpaces: false, tabSize: 8, indentSize: 8 })).toBe('Tab Size: 8');
	});
	test('tab size picks describe the configured and current size', () => {
		const picks = tabSizePicks(4, 2);
		expect(picks.map((p) => p.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
		expect(picks[1].description).toBe('Current Tab Size');
		expect(picks[3].description).toBe('Default Tab Size');
		expect(tabSizePicks(4, 4)[3].description).toBe('Configured Tab Size');
	});
	test('file association key', () => {
		expect(associationKey('src/a.tmpl')).toBe('*.tmpl');
		expect(associationKey('Dockerfile')).toBe('Dockerfile');
		expect(associationKey('x/.gitignore')).toBe('.gitignore');
	});
	test('large file thresholds and sizes', () => {
		expect(isLargeModel(21 * 1024 * 1024, 10)).toBe(true);
		expect(isLargeModel(1000, 300_001)).toBe(true);
		expect(isLargeModel(1000, 10)).toBe(false);
		expect(formatSize(512)).toBe('512B');
		expect(formatSize(10 * 1024 * 1024)).toBe('10.00MB');
	});
});

describe('an open file changed on disk', () => {
	const base = { dirty: true, inConflict: false, diskDiffers: true, autoSave: 'afterDelay' as const };
	test('clean editors reload, dirty ones are never overwritten', () => {
		expect(diskChangeAction({ ...base, dirty: false })).toBe('reload');
		expect(diskChangeAction(base)).toBe('conflict');
		expect(diskChangeAction({ ...base, autoSave: 'off' })).toBe('pause');
	});
	test('no new prompt when already in conflict or the content is the same', () => {
		expect(diskChangeAction({ ...base, inConflict: true })).toBe('none');
		expect(diskChangeAction({ ...base, diskDiffers: false })).toBe('none');
	});
});
