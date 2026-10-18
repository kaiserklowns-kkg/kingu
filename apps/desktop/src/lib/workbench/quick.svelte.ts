// Quick input state (VS Code: IQuickInputService / quick access). The prefix picks the provider:
// '>' commands, ':' go to line, '' files. `pick` shows a custom list instead (createQuickPick).

export type PickItem = {
	id: string;
	label: string;
	description?: string;
	/** Group label shown above this item. */
	separator?: string;
	/** Matched characters of `label` to highlight (a `dynamic` list ranks itself). */
	positions?: number[];
	/** A file path: the row shows that file's icon. */
	icon?: string;
};

export type Picker = {
	placeholder: string;
	items: PickItem[];
	/** Initially focused item. */
	activeId?: string;
	/** Focus moved (arrow keys, typing): e.g. preview a color theme. */
	onActive?: (item: PickItem) => void;
	onAccept: (item: PickItem) => void;
	/** Closed without accepting (Escape, focus lost). */
	onCancel?: () => void;
	/** Items computed from the typed text instead of filtering `items` (an input box). */
	dynamic?: (value: string) => PickItem[];
};

class Quick {
	visible = $state(false);
	value = $state('');
	picker = $state<Picker | null>(null);
	/** Bumped on every show/pick, so the widget resets even when it stays open in between. */
	session = $state(0);

	show(prefix = '') {
		this.hide();
		this.value = prefix;
		this.visible = true;
		this.session++;
	}

	pick(picker: Picker) {
		this.hide();
		this.picker = picker;
		this.value = '';
		this.visible = true;
		this.session++;
	}

	/** `pick` as a promise: the accepted item, undefined when dismissed. */
	choose(picker: Omit<Picker, 'onAccept' | 'onCancel'>): Promise<PickItem | undefined> {
		return new Promise((resolve) => this.pick({ ...picker, onAccept: resolve, onCancel: () => resolve(undefined) }));
	}

	/** VS Code's showInputBox: the typed (trimmed) text on Enter, undefined when dismissed.
	 * `hint` is the row shown under the input for the current text. */
	async input(opts: { placeholder: string; hint: (value: string) => string }): Promise<string | undefined> {
		const item = await this.choose({ placeholder: opts.placeholder, items: [], dynamic: (value) => [{ id: value, label: opts.hint(value) }] });
		return item?.id;
	}

	hide({ accepted = false } = {}) {
		const picker = this.picker;
		this.picker = null;
		this.visible = false;
		if (picker && !accepted) picker.onCancel?.();
	}
}

export const quick = new Quick();
