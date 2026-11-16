// The notification inbox's store (agentInbox.ts): kept in localStorage, read when the task opens.

import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { addItem, parseInbox, readTask, setRead, unreadCount, type InboxItem } from './agentInbox';

const KEY = 'kingu.agentInbox';

function load(): InboxItem[] {
	try {
		return parseInbox(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
	} catch {
		return [];
	}
}

class AgentInbox {
	items = $state<InboxItem[]>(typeof localStorage === 'undefined' ? [] : load());
	open = $state(false);
	unread = $derived(unreadCount(this.items));

	constructor() {
		if (typeof window === 'undefined') return;
		$effect.root(() => {
			$effect(() => {
				const snapshot = $state.snapshot(this.items);
				try {
					localStorage.setItem(KEY, JSON.stringify(snapshot));
				} catch {
					// Storage full or blocked: the inbox lives for this run only.
				}
			});
			// Opening a task in Agents reads its notices (Orca: activating the worktree clears its unread).
			$effect(() => {
				const slug = appMode.isAgents ? appMode.activeSession : null;
				const root = workspace.root;
				// The open folder's own notices have no root; another project's carry it (now the open one).
				if (slug) this.items = readTask(readTask(this.items, slug, null), slug, root);
			});
		});
	}

	/** A notice for task `slug` (`root`: another project's; null: the open folder's). */
	add(n: { title: string; body: string; slug: string; root: string | null }, read = false) {
		const next = addItem(this.items, { ...n, at: Date.now() });
		this.items = read ? setRead(next, [next[0].id]) : next;
	}

	markAll(read = true) {
		this.items = setRead(this.items, 'all', read);
	}

	toggle(id: string) {
		const it = this.items.find((i) => i.id === id);
		if (it) this.items = setRead(this.items, [id], !it.read);
	}

	clear() {
		this.items = [];
	}
}

export const agentInbox = new AgentInbox();
