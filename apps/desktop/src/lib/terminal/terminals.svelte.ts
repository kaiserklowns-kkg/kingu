// Terminals of the IDE panel (VS Code's terminal list): the first is a plain shell; New Terminal
// and tasks (`open({ run })`, e.g. a Snap task) add more. Each stays mounted while hidden so its
// shell keeps running; Open Folder starts over with one shell in the new root. The list survives a
// webview reload (sessionStorage), so each terminal re-attaches to its PTY under `panelKey(id)`.

import { killPty } from './pty.ts';
import { panelKey, parsePanelTerminals, persist, restore } from './sessions.ts';

export type PanelTerminal = { id: number; title: string; run?: string[] };

const STORE = 'kingu.panelTerminals';

class Terminals {
	list = $state<PanelTerminal[]>([{ id: 1, title: 'zsh' }]);
	active = $state(1);
	#seq = $state(1);

	constructor() {
		const saved = restore(STORE, parsePanelTerminals);
		if (saved) {
			this.list = saved.list;
			this.active = saved.active;
			this.#seq = saved.seq;
		}
		$effect.root(() => {
			$effect(() => persist(STORE, { list: $state.snapshot(this.list), active: this.active, seq: this.#seq }));
		});
	}

	keys(): string[] {
		return this.list.map((t) => panelKey(t.id));
	}

	/** A new terminal in the folder root, shown in the panel; `run` is typed into its shell. */
	open(opts: { title?: string; run?: string[] } = {}): number {
		const id = ++this.#seq;
		this.list = [...this.list, { id, title: opts.title ?? 'zsh', run: opts.run }];
		this.active = id;
		return id;
	}

	close(id: number) {
		const i = this.list.findIndex((t) => t.id === id);
		if (i < 0) return;
		killPty(panelKey(id));
		const next = this.list.filter((t) => t.id !== id);
		this.list = next.length ? next : [{ id: ++this.#seq, title: 'zsh' }];
		if (this.active === id) this.active = this.list[Math.min(i, this.list.length - 1)].id;
	}

	reset() {
		for (const t of this.list) killPty(panelKey(t.id));
		this.list = [{ id: ++this.#seq, title: 'zsh' }];
		this.active = this.#seq;
	}
}

export const terminals = new Terminals();
