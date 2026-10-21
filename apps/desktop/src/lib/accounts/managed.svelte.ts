// OpenCode and Devin managed data accounts (Orca's ManagedDataAccountsSection): the list the
// Rust side keeps (accounts/managed.rs), which one new agent launches use, and removal. Adding an
// account is `kingu account add --agent opencode|devin` in a terminal; the app hears about it
// through `accounts://managed-changed`.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

export type DataProvider = 'opencode' | 'devin';
export type DataAccount = { id: string; label: string; integrations: string[]; createdAt: number };
export type DataState = { accounts: DataAccount[]; activeAccountId: string | null };

export const DATA_PROVIDERS: DataProvider[] = ['opencode', 'devin'];
export const DATA_TITLE: Record<DataProvider, string> = { opencode: 'OpenCode', devin: 'Devin' };
export const addCommand = (p: DataProvider) => `kingu account add --agent ${p}`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class ManagedAccounts {
	state = $state<Partial<Record<DataProvider, DataState>>>({});
	error = $state('');
	busy = $state(false);

	async load() {
		this.busy = true;
		try {
			this.state = await invoke<Partial<Record<DataProvider, DataState>>>('managed_accounts_list');
			this.error = '';
		} catch (e) {
			this.error = message(e);
		} finally {
			this.busy = false;
		}
	}

	async select(p: DataProvider, id: string | null) {
		try {
			this.state = { ...this.state, [p]: await invoke<DataState>('managed_account_select', { provider: p, id }) };
		} catch (e) {
			notifications.error(message(e));
		}
	}

	async remove(p: DataProvider, id: string) {
		const ok = await ask(t('settings.managed.removeBody'), { title: t('settings.managed.removeTitle'), kind: 'warning', okLabel: t('settings.managed.remove') });
		if (!ok) return;
		try {
			this.state = { ...this.state, [p]: await invoke<DataState>('managed_account_remove', { provider: p, id }) };
		} catch (e) {
			notifications.error(message(e));
		}
	}

	/** Loads now and again whenever `kingu account` changes the accounts. */
	watch(): () => void {
		void this.load();
		const off = listen('accounts://managed-changed', () => void this.load());
		return () => void off.then((u) => u());
	}
}

export const managedAccounts = new ManagedAccounts();
