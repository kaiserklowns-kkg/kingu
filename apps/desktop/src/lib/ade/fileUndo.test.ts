import { expect, test } from 'bun:test';
import { FileUndo, type FileStep } from './fileUndo';

function counter(label: string, log: string[]): FileStep {
	return { label, undo: async () => void log.push(`undo ${label}`), redo: async () => void log.push(`redo ${label}`) };
}

test('undo and redo walk the history in order', async () => {
	const log: string[] = [];
	const h = new FileUndo();
	h.push(counter('a', log));
	h.push(counter('b', log));
	expect(await h.undo()).toBe('b');
	expect(await h.undo()).toBe('a');
	expect(await h.undo()).toBeNull();
	expect(await h.redo()).toBe('a');
	expect(log).toEqual(['undo b', 'undo a', 'redo a']);
	expect(h.canRedo).toBe(true);
});

test('a new step clears redo, and the history is capped', async () => {
	const log: string[] = [];
	const h = new FileUndo(2);
	h.push(counter('a', log));
	await h.undo();
	h.push(counter('b', log));
	expect(h.canRedo).toBe(false);
	h.push(counter('c', log));
	h.push(counter('d', log));
	expect(await h.undo()).toBe('d');
	expect(await h.undo()).toBe('c');
	expect(await h.undo()).toBeNull();
});

test('a failed step is dropped and the error reaches the caller', async () => {
	const h = new FileUndo();
	h.push({ label: 'x', undo: () => Promise.reject(new Error('gone')), redo: async () => {} });
	await expect(h.undo()).rejects.toThrow('gone');
	expect(h.canUndo).toBe(false);
	expect(h.canRedo).toBe(false);
});

test('one step at a time', async () => {
	const h = new FileUndo();
	let release = () => {};
	h.push({ label: 'fast', undo: async () => {}, redo: async () => {} });
	h.push({ label: 'slow', undo: () => new Promise<void>((r) => (release = r)), redo: async () => {} });
	const first = h.undo();
	expect(await h.undo()).toBeNull();
	release();
	expect(await first).toBe('slow');
	expect(await h.undo()).toBe('fast');
});
