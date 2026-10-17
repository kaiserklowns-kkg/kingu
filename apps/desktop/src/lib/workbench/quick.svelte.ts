// Quick input state (VS Code: IQuickInputService / quick access). The prefix picks the provider:
// '>' commands, ':' go to line, '' files. `pick` shows a fixed list instead (VS Code's
// createQuickPick, e.g. File: Open Recent).

export type PickItem = { label: string; detail?: string; run: () => unknown };

class Quick {
	visible = $state(false);
	value = $state('');
	/** Set while a quick pick is shown instead of the prefix providers. */
	picks = $state.raw<PickItem[] | null>(null);
	placeholder = $state('');

	show(prefix = '') {
		this.picks = null;
		this.value = prefix;
		this.visible = true;
	}

	pick(items: PickItem[], placeholder: string) {
		this.picks = items;
		this.placeholder = placeholder;
		this.value = '';
		this.visible = true;
	}

	hide() {
		this.visible = false;
		this.picks = null;
	}
}

export const quick = new Quick();
