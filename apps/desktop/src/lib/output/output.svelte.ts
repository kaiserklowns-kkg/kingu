// Output channels (VS Code: IOutputService, the Output view). Each channel is a list of lines:
// Tasks, one per language server (by its name), Git (Rust records every git run; polled while
// shown) and Kingu (the tail of Kingu.log; re-read while shown). The panel shows one channel at a
// time; Open Output in Editor shows one in a read-only editor tab (`output:<channel>`).

import { invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { afterClear, appendLines, isOutputKey, outputChannelOf, outputKey, sortChannels, textLines } from './output.ts';

export const TASKS_CHANNEL = 'Tasks';
export const GIT_CHANNEL = 'Git';
export const KINGU_CHANNEL = 'Kingu';

const ACTIVE_KEY = 'kingu.output.channel';
const POLL_MS = 1000;
/** How much of Kingu.log the Kingu channel shows. */
const LOG_TAIL_BYTES = 256 * 1024;

type GitLines = { next: number; truncated: boolean; lines: string[] };

function savedActive(): string {
	try {
		return localStorage.getItem(ACTIVE_KEY) ?? TASKS_CHANNEL;
	} catch {
		return TASKS_CHANNEL;
	}
}

class Output {
	#lines = new SvelteMap<string, readonly string[]>([
		[TASKS_CHANNEL, []],
		[GIT_CHANNEL, []],
		[KINGU_CHANNEL, []]
	]);
	/** The channels for the picker, by name. */
	channels = $derived(sortChannels([...this.#lines.keys()].map((id) => ({ id, label: id }))));
	#active = $state(savedActive());
	/** Auto scrolling off (VS Code's scroll lock): new lines do not scroll the view to the end. */
	locked = $state(false);
	/** The view's filter box (output.ts filterLines). */
	filter = $state('');

	#gitNext = 0;
	/** The Kingu channel after Clear: the last line it showed then. */
	#logCleared: string | null = null;
	#logRaw: readonly string[] = [];

	/** The shown channel (an unknown saved one falls back to Tasks). */
	get active(): string {
		return this.#lines.has(this.#active) ? this.#active : TASKS_CHANNEL;
	}
	set active(id: string) {
		this.#active = id;
		try {
			localStorage.setItem(ACTIVE_KEY, id);
		} catch {
			// Storage unavailable: the choice lasts until reload.
		}
		this.refresh(id);
	}

	lines(id: string): readonly string[] {
		return this.#lines.get(id) ?? [];
	}

	has(id: string) {
		return this.#lines.has(id);
	}

	/** Adds `text` (one or more lines) to `id`, creating the channel the first time. */
	append(id: string, text: string | readonly string[]) {
		this.#set(id, appendLines(this.lines(id), text));
	}

	replace(id: string, lines: readonly string[]) {
		this.#set(id, lines);
	}

	/** Output: Clear Output. The Kingu channel then shows only what is logged afterwards. */
	clear(id = this.active) {
		if (id === KINGU_CHANNEL) this.#logCleared = this.#logRaw.at(-1) ?? null;
		this.#set(id, []);
	}

	/** Shows the Output panel with `id` (or the active channel). */
	show(id?: string) {
		if (id) this.active = id;
		layout.showPanel('output');
	}

	/** Output: Open Output in Editor — the channel in a read-only editor tab that follows new lines. */
	openInEditor(id = this.active) {
		editors.open(outputKey(id), { preview: false });
	}

	/** The text of an `output:<channel>` editor. */
	text(key: string): string {
		return this.lines(outputChannelOf(key)).join('\n');
	}

	#set(id: string, lines: readonly string[]) {
		this.#lines.set(id, lines);
		void this.#syncEditor(id);
	}

	/** An open `output:<channel>` editor shows the channel's new text, without becoming dirty. */
	async #syncEditor(id: string) {
		const key = outputKey(id);
		if (!editors.openPaths().has(key)) return;
		const { getEntry } = await import('#lib/workbench/editorModels.ts');
		const entry = getEntry(key);
		if (!entry) return;
		const text = this.text(key);
		if (entry.model.getValue() === text) return;
		entry.reloading = true;
		try {
			entry.model.setValue(text);
			entry.savedVersion = entry.model.getAlternativeVersionId();
		} finally {
			entry.reloading = false;
		}
	}

	/** Reads the Git or Kingu channel again (others are pushed to). */
	refresh(id: string) {
		if (id === GIT_CHANNEL) void this.#pollGit();
		else if (id === KINGU_CHANNEL) void this.#readLog();
	}

	async #pollGit() {
		const got = await invoke<GitLines>('git_output_since', { since: this.#gitNext }).catch(() => null);
		if (!got) return;
		this.#gitNext = got.next;
		if (got.lines.length) this.append(GIT_CHANNEL, got.lines);
	}

	async #readLog() {
		const text = await invoke<string>('app_log_tail', { maxBytes: LOG_TAIL_BYTES }).catch((e) => `${e}`);
		this.#logRaw = textLines(text);
		const shown = afterClear(this.#logRaw, this.#logCleared);
		const old = this.lines(KINGU_CHANNEL);
		if (old.length !== shown.length || old.at(-1) !== shown.at(-1)) this.#set(KINGU_CHANNEL, shown);
	}

	/** Channels on screen: the panel's, and any open in an editor. */
	#visible(): Set<string> {
		const out = new Set<string>();
		if (layout.panelVisible && layout.panelTab === 'output') out.add(this.active);
		for (const tab of editors.allTabs()) if (isOutputKey(tab.path)) out.add(outputChannelOf(tab.path));
		return out;
	}

	/** Polls Git and Kingu only while one of them is on screen. */
	install(): () => void {
		return $effect.root(() => {
			$effect(() => {
				const shown = [...this.#visible()].filter((id) => id === GIT_CHANNEL || id === KINGU_CHANNEL);
				if (!shown.length) return;
				for (const id of shown) this.refresh(id);
				const timer = setInterval(() => shown.forEach((id) => this.refresh(id)), POLL_MS);
				return () => clearInterval(timer);
			});
		});
	}

	/** output.smartScroll.enabled. */
	get smartScroll(): boolean {
		return settings.get<boolean>('output.smartScroll.enabled');
	}
}

export const output = new Output();
