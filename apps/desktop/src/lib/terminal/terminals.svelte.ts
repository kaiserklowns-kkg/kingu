// Terminals of the IDE panel (VS Code's terminal list): the first is a plain shell; New Terminal
// and tasks (`open({ run })`, e.g. a Snap task) add more. Each stays mounted while hidden so its
// shell keeps running; Open Folder starts over with one shell in the new root.

export type PanelTerminal = { id: number; title: string; run?: string[] };

class Terminals {
	list = $state<PanelTerminal[]>([{ id: 1, title: 'zsh' }]);
	active = $state(1);
	#seq = 1;

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
		const next = this.list.filter((t) => t.id !== id);
		this.list = next.length ? next : [{ id: ++this.#seq, title: 'zsh' }];
		if (this.active === id) this.active = this.list[Math.min(i, this.list.length - 1)].id;
	}

	reset() {
		this.list = [{ id: ++this.#seq, title: 'zsh' }];
		this.active = this.#seq;
	}
}

export const terminals = new Terminals();
