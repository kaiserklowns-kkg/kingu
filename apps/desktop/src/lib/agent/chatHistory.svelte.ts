/**
 * `chatHistory` — finding a chat again: the history list's search and filters (ChatHistoryFilter
 * .svelte), transcript hits from Rust (`chat_search`, cached per query for a short while), the
 * chats with edits (`chats_with_edits`), and Agent: Show Chats… (`workbench.action.chat.history`),
 * a quick pick over the same filters (`status:` / `runtime:` / `has:edits` typed in it).
 *
 *   chatHistory.filter          the history list's filter (HistoryFilter)
 *   chatHistory.hitsFor(query)  Rust's hits for `query` (null until they come; reactive)
 *   chatHistory.facts(hits)     what filterChats needs
 *   chatHistory.showChats()     the quick pick
 */

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { timeAgo } from '#lib/ade/model.ts';
import { t } from '#lib/i18n/index.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status as statusBar } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { chats } from './chats.svelte.ts';
import { groupByDate, type DateGroup } from './chats.ts';
import { filterChats, historyStatus, NO_FILTER, parseHistoryQuery, type HistoryFacts, type HistoryFilter, type HistoryStatus, type SearchHit } from './chatHistory.ts';
import { openChat } from './chatCommands.svelte.ts';
import { runtimeOf } from './runtimes.ts';
import { agentRuntimes } from './runtimes.svelte.ts';

/** A query's hits are asked again after this long (the transcripts grow). */
const FRESH_MS = 15_000;
const DEBOUNCE_MS = 200;

export const STATUS_KEY = {
	working: 'chatHistory.status.working',
	needsInput: 'chatHistory.status.needsInput',
	idle: 'chatHistory.status.idle',
	failed: 'chatHistory.status.failed'
} as const satisfies Record<HistoryStatus, string>;

class ChatHistory {
	filter = $state<HistoryFilter>({ ...NO_FILTER });
	/** Hits by trimmed query, for the open folder (`root`). */
	#results = $state<Record<string, { at: number; hits: SearchHit[] }>>({});
	#root: string | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#pending = new Set<string>();
	/** Chats with recorded edits. */
	edited = $state<ReadonlySet<string>>(new Set());

	/** Rust's hits for `query`; null while they are asked for. Safe in `$derived` (the ask is deferred). */
	hitsFor(query: string): SearchHit[] | null {
		const q = query.trim();
		if (!q) return null;
		if (this.#root !== workspace.root) {
			this.#root = workspace.root;
			queueMicrotask(() => (this.#results = {}));
		}
		const got = this.#results[q];
		if (!got || Date.now() - got.at > FRESH_MS) this.#ask(q);
		return got?.hits ?? null;
	}

	#ask(q: string) {
		if (this.#pending.has(q)) return;
		this.#pending.add(q);
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			const asked = [...this.#pending];
			this.#pending.clear();
			// Only the newest query is worth asking for: the others were typed over.
			const last = asked[asked.length - 1];
			const root = workspace.root;
			void invoke<SearchHit[]>('chat_search', { query: last })
				.then((hits) => {
					if (workspace.root === root) this.#results = { ...this.#results, [last]: { at: Date.now(), hits } };
				})
				.catch((e) => clientLog('info', `chat search: ${e}`));
		}, DEBOUNCE_MS);
	}

	/** Reloads which chats have edits (when the history opens). */
	async loadEdited() {
		if (!workspace.root) return void (this.edited = new Set());
		this.edited = new Set(await invoke<string[]>('chats_with_edits').catch(() => []));
	}

	statusOf(id: string): HistoryStatus {
		return historyStatus(chats.run(id)?.status, chats.get(id)?.last_run?.status);
	}

	facts(hits: SearchHit[] | null): HistoryFacts {
		return { status: (id) => this.statusOf(id), edited: this.edited, hits };
	}

	runtimeName(id: string): string {
		return agentRuntimes.list.find((r) => r.id === id)?.name ?? id;
	}

	/** Agent: Show Chats… — every chat of the folder, newest first; typing searches titles and transcripts. */
	showChats() {
		if (!workspace.root) return statusBar.flash(t('chatHistory.noFolder'), 5000);
		void this.loadEdited();
		const now = Date.now();
		const label: Record<DateGroup, () => string> = {
			today: () => t('chat.history.today'),
			yesterday: () => t('chat.history.yesterday'),
			week: () => t('chat.history.week'),
			older: () => t('chat.history.older')
		};
		const items = (value: string): PickItem[] => {
			const f = parseHistoryQuery(value);
			const rows = filterChats(chats.sorted, f, this.facts(f.query ? this.hitsFor(f.query) : null));
			// Search results by match, the whole list by Today / Yesterday / Last 7 days / Older.
			const groups: { group: DateGroup | null; rows: typeof rows }[] = f.query ? [{ group: null, rows }] : groupByDate(rows.map((r) => ({ ...r, at: r.chat.updated_at || r.chat.created_at })), now);
			return groups.flatMap((g) =>
				g.rows.map((r, i) => {
					const c = r.chat;
					const meta = [t(STATUS_KEY[this.statusOf(c.id)]), c.agent ?? this.runtimeName(runtimeOf(c)), timeAgo(c.updated_at || c.created_at, now)].join(' · ');
					return { id: c.id, label: c.title, description: r.hit ? `${meta} — ${r.hit.snippets[0].text}` : meta, separator: i === 0 && g.group ? label[g.group]() : undefined };
				})
			);
		};
		quick.pick({ placeholder: t('chatHistory.pick.placeholder'), items: [], dynamic: items, onAccept: (item) => openChat(item.id) });
	}
}

export const chatHistory = new ChatHistory();
