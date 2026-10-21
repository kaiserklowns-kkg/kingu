// The usage of the providers beyond Claude and Codex (Rust accounts/providers): Gemini CLI,
// Antigravity, OpenCode Go, MiniMax, Grok, Cursor and the GLM Coding Plan. Rust decides when a
// fetch is due; this polls it with the settings it needs, keeps which Kingu-held credentials are
// saved (never their values) and each provider's sign-in status for the accounts page.

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import type { UsageWindow } from './usage';

export type ExtraProvider = 'gemini' | 'antigravity' | 'opencode-go' | 'minimax' | 'grok' | 'cursor' | 'zcode';
export type ProviderStatus = 'ok' | 'error' | 'unavailable' | 'idle';
export type ProviderUsage = {
	provider: ExtraProvider;
	status: ProviderStatus;
	session: UsageWindow | null;
	weekly: UsageWindow | null;
	monthly: UsageWindow | null;
	buckets: { name: string; window: UsageWindow }[];
	plan: string | null;
	balance: number | null;
	error: string | null;
	failure: string | null;
	provenance: string | null;
	updated_at: number | null;
};
export type GrokStatus = { signedIn: boolean; email: string | null; teamId: string | null; tokenFresh: boolean; error: string | null };
export type CursorStatus = { signedIn: boolean; email: string | null; displayName: string | null; credentialSource: 'keychain' | 'cli' | 'desktop' | null; planType: string | null; tokenFresh: boolean; error: string | null };
export type ZcodeStatus = { apiKeyConfigured: boolean; zcodeCliConfigured: boolean };
export type AgyIdentity = { email: string | null; subject: string | null; authMethod: string; identityKnown: boolean };
export type AgyState = {
	accounts: { id: string; email: string | null; subject: string | null; authMethod: string; createdAt: number }[];
	activeAccountId: string | null;
	selectedAccountId: string | null;
	currentAccount: AgyIdentity | null;
};
/** The credentials Kingu keeps in the Keychain for these providers. */
export type CredentialName = 'opencode-go:api-key' | 'opencode-go:cookie' | 'minimax:cookie' | 'minimax:api-key' | 'zcode:api-key';

const POLL_MS = 60_000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What Rust reads from Kingu's settings for these fetches. */
function config() {
	return {
		geminiCliOAuth: settings.get<boolean>('kingu.usage.gemini.cliOAuth') === true,
		antigravity: settings.get<boolean>('kingu.statusBar.antigravity.visible') !== false,
		opencodeWorkspaceId: settings.get<string>('kingu.usage.opencodeGo.workspaceId') ?? '',
		minimaxEndpoint: settings.get<string>('kingu.usage.minimax.endpoint') ?? 'overseas',
		minimaxGroupId: settings.get<string>('kingu.usage.minimax.groupId') ?? '',
		minimaxModels: settings.get<string>('kingu.usage.minimax.models') ?? 'general',
		zcodeSite: settings.get<string>('kingu.usage.zcode.site') ?? 'zai'
	};
}

class Providers {
	list = $state<ProviderUsage[]>([]);
	credentials = $state<Partial<Record<CredentialName, boolean>>>({});
	grok = $state<GrokStatus | null>(null);
	cursor = $state<CursorStatus | null>(null);
	zcode = $state<ZcodeStatus | null>(null);
	antigravity = $state<AgyState | null>(null);
	antigravityError = $state('');
	/** Providers whose manual refresh is running. */
	refreshing = $state<string[]>([]);
	#users = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	of(p: ExtraProvider): ProviderUsage | undefined {
		return this.list.find((u) => u.provider === p);
	}

	/** Fetches what is due (everything with `force`, or one provider). */
	async refresh(force = false, only?: ExtraProvider) {
		const key = only ?? 'all';
		if (force) this.refreshing = [...this.refreshing, key];
		try {
			this.list = await invoke<ProviderUsage[]>('provider_usage_refresh', { config: config(), force, only: only ?? null });
		} catch (e) {
			if (force) notifications.error(message(e));
		} finally {
			if (force) this.refreshing = this.refreshing.filter((k) => k !== key);
		}
		if (force) void this.loadStatuses();
	}

	async loadCredentials() {
		this.credentials = await invoke<Partial<Record<CredentialName, boolean>>>('provider_credentials_status').catch(() => ({}));
	}

	/** Saves (or with null, forgets) a credential; then refetches that provider. */
	async setCredential(name: CredentialName, value: string | null): Promise<boolean> {
		try {
			this.credentials = await invoke<Partial<Record<CredentialName, boolean>>>('provider_credential_set', { name, value });
			void this.refresh(true, name.split(':')[0] as ExtraProvider);
			return true;
		} catch (e) {
			notifications.error(message(e));
			return false;
		}
	}

	async loadStatuses() {
		const [grok, cursor, zcode] = await Promise.all([
			invoke<GrokStatus>('grok_status').catch(() => null),
			invoke<CursorStatus>('cursor_status').catch(() => null),
			invoke<ZcodeStatus>('zcode_status').catch(() => null)
		]);
		this.grok = grok;
		this.cursor = cursor;
		this.zcode = zcode;
	}

	async antigravityAction(action: 'list' | 'add-current' | 'select' | 'remove', id?: string) {
		try {
			this.antigravity = await invoke<AgyState>('antigravity_accounts', { action, id: id ?? null });
			this.antigravityError = '';
		} catch (e) {
			this.antigravityError = message(e);
		}
	}

	start(): () => void {
		if (this.#users++ === 0) {
			void this.refresh();
			void this.loadCredentials();
			void this.loadStatuses();
			this.#timer = setInterval(() => void this.refresh(), POLL_MS);
		}
		return () => {
			if (--this.#users === 0 && this.#timer) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
		};
	}
}

export const providers = new Providers();
