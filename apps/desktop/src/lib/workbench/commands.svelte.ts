// Command registry and keybindings (VS Code: registerAction2 → CommandsRegistry,
// MenuId.CommandPalette when `f1`, KeybindingsRegistry). One window-level key listener.

import { eventLabel as chordLabel, isMenuEcho, isModifierKey, keyOf, matches, parseChord, splitKeybinding } from './keys';
import { status } from './status.svelte';

export { keyOf };

export type Command = {
	id: string;
	title: string;
	category?: string;
	/** VS Code-style chord, e.g. `cmd+shift+p`, `ctrl+\``. `cmd` maps to Ctrl off macOS. */
	key?: string;
	/** macOS keybinding when it differs from `key` (VS Code's `mac:`), e.g. Go Back `ctrl+-` vs `alt+left`. */
	mac?: string;
	/** Listed in the command palette (VS Code's `f1: true`). Defaults to true. */
	palette?: boolean;
	when?: () => boolean;
	/** Extra condition for the keybinding only (VS Code's keybinding `when`, e.g. not in the
	 * terminal), so menus and the palette still run the command. */
	keyWhen?: () => boolean;
	run: () => unknown;
};

class Commands {
	all = $state<Command[]>([]);
	/** The last command run by a keybinding (see MENU_ECHO_MS in keys.ts). */
	lastKeyRun: { id: string; at: number } | null = null;

	get(id: string): Command | undefined {
		return this.all.find((c) => c.id === id);
	}

	enabled(id: string): boolean {
		const cmd = this.get(id);
		return !!cmd && (!cmd.when || cmd.when());
	}

	/** A click on a native or in-window menu item. */
	async runFromMenu(id: string) {
		if (isMenuEcho(id, performance.now(), this.lastKeyRun)) return;
		await this.run(id);
	}

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
	const enabled = (cmd: Command) => keyOf(cmd) && (!cmd.when || cmd.when()) && (!cmd.keyWhen || cmd.keyWhen());
	const parts = (cmd: Command) => {
		const key = keyOf(cmd);
		return key ? splitKeybinding(key) : [];
	};
	const runByKey = (cmd: Command) => {
		commands.lastKeyRun = { id: cmd.id, at: performance.now() };
		void cmd.run();
	};
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
				const p = parts(cmd);
				if (p.length === 2 && enabled(cmd) && matches(parseChord(p[0]), first) && matches(parseChord(p[1]), e)) {
					consume(e, inEditor);
					status.flash('', 0);
					runByKey(cmd);
					return;
				}
			}
			if (!inEditor) status.flash(`ไม่มีคำสั่งสำหรับปุ่ม (${chordLabel(first)}, ${chordLabel(e)})`);
			consume(e, inEditor);
			return;
		}
		for (const cmd of commands.all) {
			const p = parts(cmd);
			if (!enabled(cmd) || p.length !== 1) continue;
			if (matches(parseChord(p[0]), e)) {
				e.preventDefault();
				e.stopPropagation();
				runByKey(cmd);
				return;
			}
		}
		const startsChord = commands.all.some((cmd) => {
			const p = parts(cmd);
			return p.length === 2 && enabled(cmd) && matches(parseChord(p[0]), e);
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
