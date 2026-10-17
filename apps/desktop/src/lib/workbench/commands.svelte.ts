// Command registry and keybindings (VS Code: registerAction2 → CommandsRegistry,
// MenuId.CommandPalette when `f1`, KeybindingsRegistry). One window-level key listener.

import { eventLabel as chordLabel, isModifierKey, matches, parseChord, splitKeybinding } from './keys';
import { status } from './status.svelte';

export type Command = {
	id: string;
	title: string;
	category?: string;
	/** VS Code-style chord, e.g. `cmd+shift+p`, `ctrl+\``. `cmd` maps to Ctrl off macOS. */
	key?: string;
	/** Listed in the command palette (VS Code's `f1: true`). Defaults to true. */
	palette?: boolean;
	when?: () => boolean;
	run: () => unknown;
};

class Commands {
	all = $state<Command[]>([]);

	register(cmd: Command): () => void {
		this.all = [...this.all.filter((c) => c.id !== cmd.id), cmd];
		return () => (this.all = this.all.filter((c) => c !== cmd));
	}

	async run(id: string) {
		const cmd = this.all.find((c) => c.id === id);
		if (cmd && (!cmd.when || cmd.when())) await cmd.run();
	}

	paletteItems() {
		return this.all.filter((c) => c.palette !== false && (!c.when || c.when()));
	}
}

export const commands = new Commands();

/**
 * Capture phase, so workbench chords win over Monaco and xterm like VS Code's keybinding service.
 * Two-part chords (`cmd+k cmd+t`) wait for the second key after the first. Inside Monaco both keys
 * still reach the editor, so its own `⌘K …` chords keep working.
 */
export function installKeybindings(): () => void {
	let pending: KeyboardEvent | null = null;
	const enabled = (cmd: Command) => cmd.key && (!cmd.when || cmd.when());
	const consume = (e: KeyboardEvent, inEditor: boolean) => {
		if (inEditor) return;
		e.preventDefault();
		e.stopPropagation();
	};
	const onKey = (e: KeyboardEvent) => {
		if (isModifierKey(e)) return;
		const inEditor = e.target instanceof Element && e.target.closest('.monaco-editor') !== null;
		if (pending) {
			const first = pending;
			pending = null;
			for (const cmd of commands.all) {
				const parts = cmd.key ? splitKeybinding(cmd.key) : [];
				if (parts.length === 2 && enabled(cmd) && matches(parseChord(parts[0]), first) && matches(parseChord(parts[1]), e)) {
					consume(e, inEditor);
					status.flash('', 0);
					void cmd.run();
					return;
				}
			}
			if (!inEditor) status.flash(`ไม่มีคำสั่งสำหรับปุ่ม (${chordLabel(first)}, ${chordLabel(e)})`);
			consume(e, inEditor);
			return;
		}
		for (const cmd of commands.all) {
			if (!enabled(cmd) || splitKeybinding(cmd.key!).length !== 1) continue;
			if (matches(parseChord(cmd.key!), e)) {
				e.preventDefault();
				e.stopPropagation();
				void cmd.run();
				return;
			}
		}
		const startsChord = commands.all.some((cmd) => {
			const parts = cmd.key ? splitKeybinding(cmd.key) : [];
			return parts.length === 2 && enabled(cmd) && matches(parseChord(parts[0]), e);
		});
		if (startsChord) {
			pending = e;
			consume(e, inEditor);
			status.flash(`(${chordLabel(e)}) ถูกกดแล้ว รอปุ่มที่สองของคีย์ลัด...`);
		}
	};
	window.addEventListener('keydown', onKey, true);
	return () => window.removeEventListener('keydown', onKey, true);
}
