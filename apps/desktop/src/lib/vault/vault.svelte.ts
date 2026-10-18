// AI Vault: the sessions every agent CLI left on this machine (Rust vault_list), the full-text
// search over them, opening one read-only in an editor tab, and "Continue here": a Claude Code
// session of this folder resumes in Kingu's chat, anything else runs its CLI's resume command in
// a terminal of the session's folder (vault.ts continuePlan).

import { invoke } from '@tauri-apps/api/core';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { adeTasks } from '#lib/ade/tasks.svelte.ts';
import { chats } from '#lib/agent/chats.svelte.ts';
import { openChat } from '#lib/agent/chatCommands.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { AGENT_NAME, commandLine, continuePlan, vaultKey, type VaultSearch, type VaultSession } from './vault';

class Vault {
	rows = $state<VaultSession[]>([]);
	loading = $state(false);
	loaded = $state(false);
	error = $state('');
	/** The full-text search that produced `search` (the list shows only its hits while set). */
	searched = $state('');
	searching = $state(false);
	search = $state<VaultSearch | null>(null);
	#searchSeq = 0;
	#loadSeq = 0;

	async load() {
		const n = ++this.#loadSeq;
		this.loading = true;
		try {
			const rows = await invoke<VaultSession[]>('vault_list');
			if (n !== this.#loadSeq) return;
			this.rows = rows;
			this.error = '';
		} catch (e) {
			if (n === this.#loadSeq) this.error = String(e);
		} finally {
			if (n === this.#loadSeq) {
				this.loading = false;
				this.loaded = true;
			}
		}
	}

	/** Full-text search of every session; an empty query clears it. A newer search replaces this one. */
	async find(query: string) {
		const q = query.trim();
		const n = ++this.#searchSeq;
		if (!q) {
			this.searched = '';
			this.search = null;
			this.searching = false;
			return;
		}
		this.searching = true;
		try {
			const out = await invoke<VaultSearch>('vault_search', { query: q });
			if (n !== this.#searchSeq) return;
			this.searched = q;
			this.search = out;
		} catch (e) {
			if (n === this.#searchSeq) notifications.error(t('vault.searchFailed', { error: String(e) }));
		} finally {
			if (n === this.#searchSeq) this.searching = false;
		}
	}

	byPath(path: string): VaultSession | undefined {
		return this.rows.find((r) => r.path === path);
	}

	excerpt(path: string): string | null {
		return this.search?.hits.find((h) => h.path === path)?.excerpt ?? null;
	}

	open(s: VaultSession, pinned = false) {
		if (appMode.isAgents) appMode.setMode('workbench');
		editors.open(vaultKey(s.agent, s.path), { preview: !pinned });
	}

	async continue(s: VaultSession) {
		const plan = continuePlan(s, workspace.root, (slug) => !!adeTasks.find(slug));
		if (plan.kind === 'none') {
			status.error(plan.reason === 'noId' ? t('vault.continue.noId', { agent: AGENT_NAME[s.agent] }) : t('vault.continue.noFolder'));
			return;
		}
		if (plan.kind === 'chat') {
			const id = await chats.adopt({ title: s.title, sessionId: s.id, cwd: plan.cwd });
			if (id) openChat(id);
			else status.error(t('vault.continue.chatFailed'));
			return;
		}
		if (appMode.isAgents) appMode.setMode('workbench');
		layout.showPanel('terminal');
		terminals.open({ title: AGENT_NAME[s.agent], run: plan.run });
		status.flash(t('vault.continue.started', { agent: AGENT_NAME[s.agent] }), 3000);
	}

	async copyResume(s: VaultSession) {
		if (!s.resume) return;
		const line = s.cwd ? `cd ${commandLine([s.cwd])} && ${commandLine(s.resume)}` : commandLine(s.resume);
		await navigator.clipboard.writeText(line);
		status.flash(t('vault.copied.resume'), 2000);
	}

	async copyPath(s: VaultSession) {
		await navigator.clipboard.writeText(s.path);
		status.flash(t('vault.copied.path'), 2000);
	}
}

export const vault = new Vault();

export function installVault(): () => void {
	return commands.register({
		id: 'kingu.vault.show',
		title: 'Show AI Vault',
		category: 'View',
		run: () => {
			if (appMode.isAgents) appMode.setMode('workbench');
			layout.sideView = 'vault';
			layout.sidebarVisible = true;
		}
	});
}
