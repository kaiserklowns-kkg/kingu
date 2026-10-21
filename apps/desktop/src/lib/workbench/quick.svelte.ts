// Quick input state (VS Code: IQuickInputService / quick access). The prefix picks the provider:
// '>' commands, ':' go to line, '' files. `pick` shows a custom list instead (createQuickPick).

import { settings } from '#lib/settings/settings.svelte.ts';
import { quickInputKind, quickValueKind, recordCommand, restoredInput } from './workbenchOptions';
import { parseAlignment, type QuickAlignment } from './quickAccess';

const HISTORY_KEY = 'kingu.commandPalette.history';
/** Align Quick Input Top / Center, kept per machine like VS Code's quick input view state. */
const ALIGNMENT_KEY = 'kingu.quickInput.alignment';

function readAlignment(): QuickAlignment {
	try {
		return parseAlignment(localStorage.getItem(ALIGNMENT_KEY));
	} catch {
		return 'top';
	}
}

function readHistory(): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

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
	/** An agent: the row shows its mark (agent/agentIcons.ts), over `icon`. */
	agent?: string;
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
	/** Names the picker, so a command can tell its own picker is open (⌃Tab pressed again). */
	id?: string;
	/** VS Code's quickNavigate: releasing Ctrl/Cmd accepts the focused item (the ⌃Tab switcher). */
	quickNavigate?: boolean;
	/** An input box for a secret (a task's promptString input with `password`): typed text is hidden. */
	password?: boolean;
};

class Quick {
	visible = $state(false);
	value = $state('');
	picker = $state<Picker | null>(null);
	/** Bumped on every show/pick, so the widget resets even when it stays open in between. */
	session = $state(0);
	/** A request to move the focused item by `delta` (wrapping), bumped by `moveSelection`. */
	step = $state({ n: 0, delta: 0 });

	moveSelection(delta: number) {
		this.step = { n: this.step.n + 1, delta };
	}

	/** The last text typed in the command palette and in Quick Open (for their `preserveInput` settings). */
	#lastInput: { commands?: string; files?: string } = {};
	/** `workbench.commandPalette.history`: recently run palette commands, most recent first. */
	commandHistory = $state<string[]>(readHistory());
	/** Where the quick input sits: below the title bar, or a quarter down the window. */
	alignment = $state<QuickAlignment>(readAlignment());

	setAlignment(alignment: QuickAlignment) {
		this.alignment = alignment;
		try {
			localStorage.setItem(ALIGNMENT_KEY, alignment);
		} catch {
			// Storage unavailable: the choice lasts until the window reloads.
		}
	}

	/**
	 * Opens quick access at `prefix`. `workbench.commandPalette.preserveInput` and
	 * `workbench.quickOpen.preserveInput` bring back the last text typed there (selected, so typing replaces it).
	 */
	show(prefix = '') {
		this.hide();
		const kind = quickInputKind(prefix);
		const preserve = kind === 'commands' ? settings.get<boolean>('workbench.commandPalette.preserveInput') : kind === 'files' ? settings.get<boolean>('workbench.quickOpen.preserveInput') : false;
		this.value = kind ? restoredInput(prefix, this.#lastInput[kind], preserve) : prefix;
		this.selectRestored = this.value !== prefix;
		this.visible = true;
		this.session++;
	}

	/** The input opened with restored text, which starts selected. */
	selectRestored = false;

	/** A command run from the palette: it moves to the top of the history. */
	recordCommand(id: string) {
		this.commandHistory = recordCommand(this.commandHistory, id, settings.get<number>('workbench.commandPalette.history'));
		try {
			localStorage.setItem(HISTORY_KEY, JSON.stringify(this.commandHistory));
		} catch {
			// Storage unavailable: the history lasts until reload.
		}
	}

	pick(picker: Picker) {
		this.hide();
		this.picker = picker;
		this.value = '';
		this.selectRestored = false;
		this.visible = true;
		this.session++;
	}

	/** `pick` as a promise: the accepted item, undefined when dismissed. */
	choose(picker: Omit<Picker, 'onAccept' | 'onCancel'>): Promise<PickItem | undefined> {
		return new Promise((resolve) => this.pick({ ...picker, onAccept: resolve, onCancel: () => resolve(undefined) }));
	}

	/** VS Code's showInputBox: the typed (trimmed) text on Enter, undefined when dismissed.
	 * `hint` is the row shown under the input for the current text; `value` is the starting text
	 * (selected, so typing replaces it); `password` hides what is typed. */
	async input(opts: { placeholder: string; hint: (value: string) => string; value?: string; password?: boolean }): Promise<string | undefined> {
		const item = this.choose({ placeholder: opts.placeholder, items: [], password: opts.password, dynamic: (value) => [{ id: value, label: opts.hint(value) }] });
		if (opts.value) {
			this.value = opts.value;
			this.selectRestored = true;
		}
		return (await item)?.id;
	}

	hide({ accepted = false } = {}) {
		const picker = this.picker;
		if (this.visible && !picker) {
			const kind = quickValueKind(this.value);
			if (kind) this.#lastInput[kind] = this.value;
		}
		this.picker = null;
		this.visible = false;
		if (picker && !accepted) picker.onCancel?.();
	}
}

export const quick = new Quick();
