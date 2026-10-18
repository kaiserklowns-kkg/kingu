// Terminals of the IDE panel (VS Code's terminal list): the first is a plain shell; New Terminal
// and tasks (`open({ run })`, e.g. a Snap task) add more. Each stays mounted while hidden so its
// shell keeps running. The list belongs to the open folder (`load(tag)`), is kept in localStorage
// per folder, and comes back after a reload, a folder switch or an app restart: each terminal
// re-attaches to its PTY under `panelKey(tag, id)`.

import { killPty } from './pty.ts';
import { panelKey, parsePanelTerminals, persist, restore, storeName, withoutRun } from './sessions.ts';

export type PanelTerminal = { id: number; title: string; run?: string[] };

const STORE = 'kingu.panelTerminals';

class Terminals {
	list = $state<PanelTerminal[]>([]);
	active = $state(0);
	/** Root tag of the folder whose terminals these are; null until loaded (nothing mounts). */
	tag = $state<string | null>(null);
	#seq = $state(0);

	constructor() {
		$effect.root(() => {
			$effect(() => {
				const state = { list: $state.snapshot(this.list), active: this.active, seq: this.#seq };
				if (this.tag) persist(storeName(STORE, this.tag), state);
			});
		});
	}

	/** Shows folder `tag`'s terminals: the saved list, else one shell. */
	load(tag: string) {
		const saved = restore(storeName(STORE, tag), parsePanelTerminals);
		if (saved) {
			this.list = saved.list.map(withoutRun);
			this.active = saved.active;
			this.#seq = saved.seq;
		} else {
			this.list = [{ id: 1, title: 'zsh' }];
			this.active = 1;
			this.#seq = 1;
		}
		this.tag = tag;
	}

	/** Another folder is about to load: unmount (the shells keep running). */
	unload() {
		this.tag = null;
		this.list = [];
	}

	key(id: number): string {
		return panelKey(this.tag ?? '', id);
	}

	keys(): string[] {
		return this.tag ? this.list.map((t) => this.key(t.id)) : [];
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
		killPty(this.key(id));
		const next = this.list.filter((t) => t.id !== id);
		this.list = next.length ? next : [{ id: ++this.#seq, title: 'zsh' }];
		if (this.active === id) this.active = this.list[Math.min(i, this.list.length - 1)].id;
	}
}

export const terminals = new Terminals();
