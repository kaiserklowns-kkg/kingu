// Quick input state (VS Code: IQuickInputService / quick access). The prefix picks the provider:
// '>' commands, ':' go to line, '' files. `pick` shows a custom list instead (createQuickPick).

export type PickItem = { id: string; label: string; description?: string; /** Group label shown above this item. */ separator?: string };

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

	hide({ accepted = false } = {}) {
		const picker = this.picker;
		this.picker = null;
		this.visible = false;
		if (picker && !accepted) picker.onCancel?.();
	}
}

export const quick = new Quick();
