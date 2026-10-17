// Command registry and keybindings (VS Code: registerAction2 → CommandsRegistry,
// MenuId.CommandPalette when `f1`, KeybindingsRegistry). One window-level key listener.

import { matches, parseChord } from './keys';

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

/** Capture phase, so workbench chords win over Monaco and xterm like VS Code's keybinding service. */
export function installKeybindings(): () => void {
	const onKey = (e: KeyboardEvent) => {
		for (const cmd of commands.all) {
			if (!cmd.key || (cmd.when && !cmd.when())) continue;
			if (matches(parseChord(cmd.key), e)) {
				e.preventDefault();
				e.stopPropagation();
				void cmd.run();
				return;
			}
		}
	};
	window.addEventListener('keydown', onKey, true);
	return () => window.removeEventListener('keydown', onKey, true);
}
