// The floating workspace (Orca's): a panel over everything, in the IDE and the Agents layout, with
// its own terminal and markdown note tabs, independent of the open worktree. Minimizing only
// hides it, so its shells keep running. Open/maximized, bounds and the toggle button's place are
// remembered.
//   floating.toggle() / show() / hide() / openMaximized()
//   floating.newTerminal() / newNote() / openNote() / closeTab(id)

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { settings } from '#lib/settings/settings.svelte.ts';
import { status } from './status.svelte';
import { anchorButton, anchorRect, buttonPos, DEFAULT_BOUNDS, DEFAULT_BUTTON, maximizedRect, rectFromAnchor, type Anchor, type AnchoredBounds, type Rect } from './floating';

const VIEW_KEY = 'kingu.floating.view';
const BOUNDS_KEY = 'kingu.floating.bounds';
const BUTTON_KEY = 'kingu.floating.button';

function read<T>(key: string): T | null {
	try {
		return JSON.parse(localStorage.getItem(key) ?? 'null');
	} catch {
		return null;
	}
}
function write(key: string, v: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(v));
	} catch {
		// A convenience only.
	}
}

export type FloatingTab = { id: string; kind: 'terminal' | 'note'; title: string; path?: string };

class Floating {
	enabled = $derived(settings.get<boolean>('kingu.floating.enabled') !== false);
	location = $derived((settings.get<string>('kingu.floating.triggerLocation') ?? 'floating-button') as 'floating-button' | 'status-bar');

	open = $state(read<{ open: boolean }>(VIEW_KEY)?.open ?? false);
	maximized = $state(read<{ maximized: boolean }>(VIEW_KEY)?.maximized ?? false);
	bounds = $state<AnchoredBounds>(read<AnchoredBounds>(BOUNDS_KEY) ?? DEFAULT_BOUNDS);
	button = $state<Anchor>(read<Anchor>(BUTTON_KEY) ?? DEFAULT_BUTTON);
	/** The window size, so anchored positions follow resizes. */
	vw = $state(typeof window === 'undefined' ? 1440 : window.innerWidth);
	vh = $state(typeof window === 'undefined' ? 900 : window.innerHeight);

	tabs = $state<FloatingTab[]>([]);
	active = $state<string | null>(null);
	/** Tabs with output since they were last seen (the amber dot on the toggle). */
	unread = $state<Record<string, boolean>>({});
	hasUnread = $derived(Object.values(this.unread).some(Boolean));
	/** Mounted while open or while it has tabs, so hidden shells keep running. */
	mounted = $derived(this.enabled && (this.open || this.tabs.length > 0));

	rect = $derived<Rect>(this.maximized ? maximizedRect(this.vw, this.vh) : rectFromAnchor(this.bounds, this.vw, this.vh));
	buttonAt = $derived(buttonPos(this.button, this.vw, this.vh));

	#seq = 0;
	/** Focus to give back when the panel hides. */
	#returnFocus: HTMLElement | null = null;

	#saveView() {
		write(VIEW_KEY, { open: this.open, maximized: this.maximized });
	}

	show() {
		if (!this.enabled) return;
		const el = document.activeElement as HTMLElement | null;
		if (el && !el.closest('[data-floating-terminal-panel],[data-floating-terminal-toggle]')) this.#returnFocus = el;
		this.open = true;
		if (this.active) this.unread[this.active] = false;
		this.#saveView();
	}
	hide() {
		this.open = false;
		this.#saveView();
		const back = this.#returnFocus;
		this.#returnFocus = null;
		requestAnimationFrame(() => back?.focus({ preventScroll: true }));
	}
	toggle() {
		if (this.open) this.hide();
		else this.show();
	}
	openMaximized() {
		this.maximized = true;
		this.show();
	}
	toggleMaximized() {
		this.maximized = !this.maximized;
		this.#saveView();
	}

	/** Commits a moved or resized rect, anchored to its nearest corner. */
	commit(r: Rect) {
		this.bounds = anchorRect(r, this.vw, this.vh);
		write(BOUNDS_KEY, this.bounds);
	}
	commitButton(p: { left: number; top: number }) {
		this.button = anchorButton(p, this.vw, this.vh);
		write(BUTTON_KEY, this.button);
	}
	resized() {
		this.vw = window.innerWidth;
		this.vh = window.innerHeight;
	}

	setLocation(where: 'floating-button' | 'status-bar') {
		void settings.set('kingu.floating.triggerLocation', where === 'floating-button' ? undefined : where, 'user');
	}
	disable() {
		this.hide();
		void settings.set('kingu.floating.enabled', false, 'user');
	}

	select(id: string) {
		this.active = id;
		this.unread[id] = false;
	}
	#add(tab: Omit<FloatingTab, 'id'>) {
		const id = `f${++this.#seq}`;
		this.tabs = [...this.tabs, { ...tab, id }];
		this.select(id);
		this.show();
		return id;
	}
	newTerminal() {
		const n = this.tabs.filter((t) => t.kind === 'terminal').length + 1;
		return this.#add({ kind: 'terminal', title: n === 1 ? 'Terminal' : `Terminal ${n}` });
	}
	async newNote() {
		try {
			const path = await invoke<string>('floating_note_new');
			this.#add({ kind: 'note', title: path.split('/').pop() ?? 'Untitled.md', path });
		} catch (e) {
			status.error(`Failed to create untitled markdown file. ${e}`);
		}
	}
	async openNote() {
		try {
			const dir = await invoke<string>('floating_dir');
			const picked = await openDialog({ defaultPath: dir, multiple: false, directory: false, filters: [{ name: 'Markdown', extensions: ['md', 'mdx', 'markdown'] }] });
			if (typeof picked !== 'string') return;
			const open = this.tabs.find((t) => t.path === picked);
			if (open) return this.select(open.id);
			this.#add({ kind: 'note', title: picked.split('/').pop() ?? picked, path: picked });
		} catch (e) {
			status.error(`Failed to open markdown file. ${e}`);
		}
	}
	rename(id: string, title: string) {
		const t = this.tabs.find((t) => t.id === id);
		if (t && title.trim()) t.title = title.trim();
	}
	/** Closes a tab (ending its shell); with none left, Orca hides the panel. */
	closeTab(id: string) {
		const i = this.tabs.findIndex((t) => t.id === id);
		if (i < 0) return;
		this.tabs = this.tabs.filter((t) => t.id !== id);
		delete this.unread[id];
		if (this.active === id) this.active = this.tabs[Math.min(i, this.tabs.length - 1)]?.id ?? null;
	}
	/** Output in a tab the user is not looking at. */
	activity(id: string) {
		if (!this.open || this.active !== id) this.unread[id] = true;
	}
}

export const floating = new Floating();
