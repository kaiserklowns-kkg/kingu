// The floating workspace (Orca's): a panel over everything, in the IDE and the Agents layout, with
// its own terminal and markdown note tabs, independent of the open worktree. Minimizing only
// hides it, so its shells keep running. Open/maximized, bounds and the toggle button's place are
// remembered.
//   floating.toggle() / show() / hide() / openMaximized()
//   floating.newTerminal() / newNote() / openNote() / newBrowser() / closeTab(id)

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { settings } from '#lib/settings/settings.svelte.ts';
import { status } from './status.svelte';
import { killPty, listPtys } from '#lib/terminal/pty.ts';
import { floatingKey, ownSessions } from '#lib/terminal/sessions.ts';

/** Floating tabs are not restored, so each launch's shells get their own keys. */
const LAUNCH = Date.now().toString(36);
import { anchorButton, anchorRect, buttonPos, DEFAULT_BOUNDS, defaultButton, keepButtonClear, maximizedRect, rectFromAnchor, usableButtonViewport, type Anchor, type AnchoredBounds, type Rect } from './floating';
import { keepClear } from './floatingKeepClear.svelte';
import { t } from '#lib/i18n/index.ts';

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

/** `run`: typed into a terminal's shell when it starts (an `ssh -t …` of an SSH project). */
/** `agent`: the webview label of a page an agent opened (Rust floating_browser/agent.rs), shown in this tab. */
export type FloatingTab = { id: string; kind: 'terminal' | 'note' | 'browser'; title: string; path?: string; url?: string; run?: string[]; agent?: string };

/** Who follows a terminal tab: its title (OSC 0/2), its output, and its closing (SSH agent status). */
export type FloatingWatch = { title?: (title: string) => void; output?: () => void; closed?: () => void };

class Floating {
	enabled = $derived(settings.get<boolean>('kingu.floating.enabled') !== false);
	location = $derived((settings.get<string>('kingu.floating.triggerLocation') ?? 'floating-button') as 'floating-button' | 'status-bar');

	open = $state(read<{ open: boolean }>(VIEW_KEY)?.open ?? false);
	maximized = $state(read<{ maximized: boolean }>(VIEW_KEY)?.maximized ?? false);
	bounds = $state<AnchoredBounds>(read<AnchoredBounds>(BOUNDS_KEY) ?? DEFAULT_BOUNDS);
	/** Where the user dropped the toggle; null keeps Orca's default spot, which follows the window's width. */
	button = $state<Anchor | null>(read<Anchor>(BUTTON_KEY));
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
	/** The toggle's spot before it moves off a page part it must not cover (the chat composer…). */
	buttonSpot = $derived(buttonPos(this.button ?? defaultButton(this.vw), this.vw, this.vh));
	/** Where the toggle shows: its spot, or just below or above a page part it would cover (Orca's keep-clear). */
	buttonAt = $derived(keepButtonClear(this.buttonSpot, keepClear.rects, this.vw, this.vh));

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
	/** A dropped toggle, saved where it shows: clear of the page parts it must not cover. */
	commitButton(p: { left: number; top: number }) {
		// Orca waits for a usable window before saving a spot it would have to clamp.
		if (!usableButtonViewport(this.vw, this.vh)) return;
		this.button = anchorButton(keepButtonClear(p, keepClear.rects, this.vw, this.vh), this.vw, this.vh);
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

	/** The terminal session of tab `id` (Terminal.svelte's `key`). */
	terminalKey(id: string) {
		return floatingKey(LAUNCH, id);
	}

	/** The webview label of browser tab `id` (Rust floating_browser_*). */
	browserLabel(id: string) {
		return `floating-browser-${LAUNCH}-${id}`;
	}

	/** Shells of an earlier launch's floating tabs (tabs are not restored): ended once at start. */
	async endStaleShells() {
		// Another open window's floating tabs are its own (each page load has its own LAUNCH).
		for (const s of ownSessions(await listPtys())) if (s.key.startsWith('floating:') && !s.key.startsWith(`floating:${LAUNCH}:`)) killPty(s.key);
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
	newBrowser(url = '') {
		return this.#add({ kind: 'browser', title: 'New Tab', url });
	}
	/** A page an agent opened (VS Code opens it in an editor; here a browser tab of this panel, shown). */
	newAgentBrowser(label: string, url: string) {
		const open = this.tabs.find((t) => t.agent === label);
		if (open) return (this.select(open.id), this.show(), open.id);
		return this.#add({ kind: 'browser', title: url, url, agent: label });
	}
	newTerminal(opts: { title?: string; run?: string[]; watch?: FloatingWatch } = {}) {
		const n = this.tabs.filter((t) => t.kind === 'terminal').length + 1;
		const id = this.#add({ kind: 'terminal', title: opts.title ?? (n === 1 ? 'Terminal' : `Terminal ${n}`), ...(opts.run ? { run: opts.run } : {}) });
		if (opts.watch) this.#watch.set(id, opts.watch);
		return id;
	}
	#watch = new Map<string, FloatingWatch>();
	/** A terminal tab's title changed. */
	titled(id: string, title: string) {
		this.#watch.get(id)?.title?.(title);
	}
	/** A terminal tab printed something. */
	output(id: string) {
		this.activity(id);
		this.#watch.get(id)?.output?.();
	}
	async newNote() {
		try {
			const path = await invoke<string>('floating_note_new');
			this.#add({ kind: 'note', title: path.split('/').pop() ?? 'Untitled.md', path });
		} catch (e) {
			status.error(t('workbench.floating.newNoteFailed', { error: String(e) }));
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
			status.error(t('workbench.floating.openNoteFailed', { error: String(e) }));
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
		if (this.tabs[i].kind === 'terminal') killPty(this.terminalKey(id));
		this.#watch.get(id)?.closed?.();
		this.#watch.delete(id);
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
if (typeof window !== 'undefined') void floating.endStaleShells();
