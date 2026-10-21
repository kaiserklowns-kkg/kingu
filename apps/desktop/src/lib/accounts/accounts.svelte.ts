// AI accounts (Orca's Manage Accounts) and plan usage for the footer. Rust keeps the accounts,
// the API keys (Keychain) and the CLIs' tokens; this side only sees labels, states and numbers.
// Login runs the provider CLI's own login in a Kingu terminal with the account's folder.

import { invoke } from '@tauri-apps/api/core';
import { ask } from '#lib/workbench/messageBox.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { team } from '#lib/team/team.svelte.ts';
import { PROVIDER_TITLE, type AccountsView, type AccountView, type Kind, type Provider, type Sample, type UsageRow } from './usage';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

/** Rust decides whether a request is due (15 min, backoff); asking every minute is cheap. */
const POLL_MS = 60_000;
const LOGIN_WATCH_MS = 2_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Accounts {
	rows = $state<UsageRow[]>([]);
	view = $state<AccountsView | null>(null);
	refreshing = $state(false);
	/** Account ids whose login terminal is open and watched. */
	loggingIn = $state<string[]>([]);
	/** The account whose API key field is open in the accounts view. */
	editingKey = $state<string | null>(null);
	now = $state(Date.now());
	#timer: ReturnType<typeof setInterval> | undefined;
	#users = 0;

	async refresh(force = false) {
		if (force) this.refreshing = true;
		try {
			this.rows = await invoke<UsageRow[]>('ai_usage_refresh', { force });
		} catch (e) {
			if (force) notifications.error(t('team.accounts.refreshFailed', { error: message(e) }));
		} finally {
			this.now = Date.now();
			if (force) this.refreshing = false;
		}
	}

	async load() {
		try {
			this.view = await invoke<AccountsView>('ai_accounts_list');
		} catch (e) {
			notifications.error(t('team.accounts.listFailed', { error: message(e) }));
		}
	}

	/** Polling while the footer item is shown (counted, so two users share one timer). */
	start(): () => void {
		if (this.#users++ === 0) {
			void this.refresh();
			this.#timer = setInterval(() => void this.refresh(), POLL_MS);
		}
		return () => {
			if (--this.#users === 0 && this.#timer) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
		};
	}

	async history(key: string): Promise<Sample[]> {
		return invoke<Sample[]>('ai_usage_history', { key }).catch(() => []);
	}

	async #changed() {
		await this.load();
		await this.refresh();
	}

	/** Palette / Manage Accounts: name it, then log in (subscription) or paste a key. */
	async add(provider: Provider, kind?: Kind) {
		const title = PROVIDER_TITLE[provider];
		if (!kind) {
			const picked = await quick.choose({
				placeholder: t('team.accounts.addPlaceholder', { provider: title }),
				items: [
					{ id: 'subscription', label: provider === 'claude' ? 'Claude subscription (Pro / Max)' : 'ChatGPT (Plus / Pro)', description: t('team.accounts.subscriptionDesc') },
					{ id: 'api_key', label: 'API key', description: t('team.accounts.apiKeyDesc') }
				]
			});
			if (!picked) return;
			kind = picked.id as Kind;
		}
		const label = await quick.input({
			placeholder: t('team.accounts.namePlaceholder', { provider: title }),
			hint: (v) => (v.trim() ? t('team.accounts.nameHintAdd', { name: v.trim() }) : t('team.accounts.nameHintEmpty'))
		});
		if (!label?.trim()) return;
		try {
			const account = await invoke<AccountView>('ai_account_add', { provider, kind, label });
			await this.load();
			if (kind === 'subscription') await this.login(account.id);
			else {
				this.editingKey = account.id;
				systemSettings.showAccounts();
			}
		} catch (e) {
			notifications.error(t('team.accounts.addFailed', { error: message(e) }));
		}
	}

	/** Types the CLI login into a new terminal and watches for the login to appear. */
	async login(id: string) {
		const account = this.view?.accounts.find((a) => a.id === id);
		try {
			const run = await invoke<string[]>('ai_account_login_command', { id });
			systemSettings.close();
			appMode.setMode('workbench');
			terminals.open({ title: t('team.accounts.loginTerminal', { name: account?.label ?? PROVIDER_TITLE[account?.provider ?? 'claude'] }), run });
			layout.showPanel('terminal');
			status.flash(t('team.accounts.loginSteps'), 8000);
			void this.#watchLogin(id);
		} catch (e) {
			notifications.error(t('team.accounts.loginStartFailed', { error: message(e) }));
		}
	}

	/** Logins the user cancelled (Orca's Cancel next to Add Account): their watch stops. */
	#cancelled = new Set<string>();

	/** Stops waiting for a login; the terminal it was typed into stays open. */
	cancelLogin(id: string) {
		this.#cancelled.add(id);
		this.loggingIn = this.loggingIn.filter((x) => x !== id);
	}

	/** The CLI login an account runs, as one line for another terminal (Orca's "Copy sign-in link"). */
	async copyLoginCommand(id: string) {
		try {
			const run = await invoke<string[]>('ai_account_login_command', { id });
			await navigator.clipboard.writeText(run.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`)).join(' '));
			status.flash(t('settings.accounts.copied'), 4000);
		} catch (e) {
			notifications.error(t('team.accounts.loginStartFailed', { error: message(e) }));
		}
	}

	async #watchLogin(id: string) {
		if (this.loggingIn.includes(id)) return;
		this.#cancelled.delete(id);
		this.loggingIn = [...this.loggingIn, id];
		const until = Date.now() + LOGIN_TIMEOUT_MS;
		try {
			while (Date.now() < until && !this.#cancelled.has(id)) {
				await new Promise((r) => setTimeout(r, LOGIN_WATCH_MS));
				await this.load();
				const a = this.view?.accounts.find((x) => x.id === id);
				if (!a) return;
				if (a.signed_in) {
					// A fresh login is what the user wants agents to use (Orca selects it too).
					await invoke('ai_account_set_active', { provider: a.provider, id });
					await this.#changed();
					const provider = PROVIDER_TITLE[a.provider];
					status.flash(a.email ? t('team.accounts.loggedInEmail', { provider, name: a.label, email: a.email }) : t('team.accounts.loggedIn', { provider, name: a.label }));
					return;
				}
			}
		} finally {
			this.loggingIn = this.loggingIn.filter((x) => x !== id);
		}
	}

	async setKey(id: string, key: string): Promise<string | null> {
		try {
			await invoke('ai_account_set_key', { id, key });
			this.editingKey = null;
			await this.#changed();
			return null;
		} catch (e) {
			return message(e);
		}
	}

	async setActive(provider: Provider, id: string | null) {
		try {
			await invoke('ai_account_set_active', { provider, id });
			await this.#changed();
			const a = this.view?.accounts.find((x) => x.id === id);
			const title = PROVIDER_TITLE[provider];
			status.flash(id ? t('team.accounts.usesAccount', { provider: title, name: a?.label ?? id }) : t('team.accounts.usesOwn', { provider: title }));
		} catch (e) {
			status.flash(message(e));
		}
	}

	async remove(id: string) {
		const a = this.view?.accounts.find((x) => x.id === id);
		if (!a) return;
		const ok = await ask(
			a.kind === 'api_key'
				? t('team.accounts.removeKeyConfirm', { name: a.label })
				: t('team.accounts.removeLoginConfirm', { name: a.label, provider: a.provider }),
			{ title: t('team.accounts.removeTitle'), kind: 'warning' }
		);
		if (!ok) return;
		try {
			await invoke('ai_account_remove', { id });
			await this.#changed();
			status.flash(t('team.accounts.removed', { name: a.label }));
		} catch (e) {
			notifications.error(t('team.accounts.removeFailed', { error: message(e) }));
		}
	}

	async pickLogin() {
		await this.load();
		const subs = this.view?.accounts.filter((a) => a.kind === 'subscription') ?? [];
		if (!subs.length) return this.add('claude', 'subscription');
		const picked = await quick.choose({
			placeholder: t('team.accounts.loginPlaceholder'),
			items: subs.map((a) => ({ id: a.id, label: `${PROVIDER_TITLE[a.provider]}: ${a.label}`, description: a.signed_in ? (a.email ?? t('team.accounts.loggedInDesc')) : t('team.accounts.notLoggedIn') }))
		});
		if (picked) await this.login(picked.id);
	}

	manage() {
		void this.load();
		systemSettings.showAccounts();
	}

	install(): () => void {
		const unregister = [
			commands.register({ id: 'kingu.accounts.addClaude', title: 'Add Claude Account…', category: 'Accounts', run: () => this.add('claude') }),
			commands.register({ id: 'kingu.accounts.addCodex', title: 'Add Codex Account…', category: 'Accounts', run: () => this.add('codex') }),
			commands.register({ id: 'kingu.accounts.login', title: 'Login…', category: 'Accounts', run: () => this.pickLogin() }),
			commands.register({ id: 'kingu.accounts.manage', title: 'Manage Accounts…', category: 'Accounts', run: () => this.manage() }),
			commands.register({ id: 'kingu.accounts.refreshUsage', title: 'Refresh Usage', category: 'Accounts', run: () => this.refresh(true) })
		];
		return () => unregister.forEach((u) => u());
	}
}

export const accounts = new Accounts();

/** The title bar's Accounts button: AI accounts and the team server. */
export function showAccountsMenu() {
	const signedIn = !!team.status?.signed_in;
	quick.pick({
		placeholder: t('team.accounts.menuPlaceholder'),
		items: [
			{ id: 'ai', label: t('team.accounts.manageAi'), description: 'Claude, Codex: login / API key / usage' },
			{ id: 'team', label: signedIn ? t('team.accounts.teamServer') : t('team.accounts.signInTeamServer') }
		],
		onAccept: (item) => (item.id === 'ai' ? accounts.manage() : team.showMenu())
	});
}
