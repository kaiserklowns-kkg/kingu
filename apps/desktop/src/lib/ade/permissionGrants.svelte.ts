// The permission grants Kingu gave a terminal claude (Rust agent/permission_rules.rs): where an
// "Always allow" would save a waiting request's rules (for the card and the phone), and the list
// of grants that still stand with Revoke for each saved rule, like VS Code's tool approval
// manager (chat/browser/tools/languageModelToolsConfirmationService.ts
// `manageConfirmationPreferences`; terminalToolConfirmationContribution.ts: each command rule with
// a trash button). A session grant cannot be taken back from outside claude: it is listed as
// ending with its session.
import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import type { GrantScope } from './permissionAsk';

/** Where a rule of a scope would be saved (permission_rules.rs `ScopeFiles`). */
export type ScopeFiles = { files: string[]; tracked: boolean };
export type Scopes = { project: ScopeFiles | null; user: ScopeFiles | null };

/** One grant on record (permission_rules.rs `GrantView`). */
export type GrantView = {
	id: string;
	scope: GrantScope;
	grant: string;
	tool: string | null;
	detail: string | null;
	cwd: string | null;
	at: number;
	live: boolean;
	file: string | null;
	files: string[];
	tracked: boolean;
};

/** Persisted rules first (they outlive the session), newest first within each. */
export function sortGrants(list: GrantView[]): GrantView[] {
	const rank = (g: GrantView) => (g.scope === 'session' ? 1 : 0);
	return [...list].sort((a, b) => rank(a) - rank(b) || b.at - a.at);
}

class PermissionGrants {
	open = $state(false);
	list = $state<GrantView[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);
	/** Scope files by `token:hold`, fetched once per waiting request. */
	scopes = $state<Record<string, Scopes>>({});
	#asked = new Set<string>();

	/**
	 * The scope files of a waiting request; undefined until known. Safe to call while rendering:
	 * the fetch writes state only when it returns.
	 */
	scopesOf(token: string | undefined, hold: string | undefined): Scopes | undefined {
		if (!token || !hold) return undefined;
		const id = `${token}:${hold}`;
		if (!this.#asked.has(id)) {
			this.#asked.add(id);
			void invoke<Scopes>('agent_permission_scopes', { token, hold })
				.then((s) => (this.scopes = { ...this.scopes, [id]: s }))
				.catch(() => {});
		}
		return this.scopes[id];
	}

	async show() {
		this.open = true;
		await this.refresh();
	}

	async refresh() {
		this.loading = true;
		this.error = null;
		try {
			this.list = sortGrants(await invoke<GrantView[]>('agent_permission_grants'));
		} catch (e) {
			this.error = String(e);
		} finally {
			this.loading = false;
		}
	}

	async revoke(g: GrantView) {
		const rule = g.grant.replace(/^rule:/, '');
		if (!(await ask(t('legacyAde.permissionGrants.revokeConfirm', { rule, file: g.file ?? '' }), { okLabel: t('legacyAde.permissionGrants.revoke'), kind: 'warning' }))) return;
		try {
			const r = await invoke<{ files: string[] }>('agent_permission_revoke', { id: g.id });
			status.flash(r.files.length ? t('legacyAde.permissionGrants.revoked', { rule }) : t('legacyAde.permissionGrants.forgotten', { rule }), 6000);
		} catch (e) {
			notifications.error(t('legacyAde.permissionGrants.revokeFailed', { error: String(e) }));
		}
		await this.refresh();
	}
}

export const permissionGrants = new PermissionGrants();

export function installPermissionGrants(): () => void {
	return commands.register({ id: 'kingu.agent.permissionGrants', title: 'Agents: Permission Grants…', category: 'Agents', run: () => void permissionGrants.show() });
}
