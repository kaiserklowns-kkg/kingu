// The project pane's GitHub account picker (Orca's RepositoryGitHubAccountSection): gh's logins as
// Rust lists them (agent/gh_account.rs), the project's binding (`kingu.repo.ghAccount`), and the
// Kingu-only suggestion (the login that owns origin). Pure, so `bun test` covers it.

export type GhBinding = { host: string; user: string };
export type GhAccount = GhBinding & { active: boolean; source: 'keyring' | 'env'; envToken: string | null; scopes: string[] };
export type GhInventory = { installed: boolean; capability: 'supported' | 'unsupported' | 'unknown'; accounts: GhAccount[]; binding: GhBinding | null; suggested: GhBinding | null };

/** Orca's sentinel for "no binding" (a select value can't be empty). */
export const AMBIENT = '__ambient_gh_login__';

export const accountKey = (b: GhBinding) => `${b.host.toLowerCase()}\u0000${b.user.toLowerCase()}`;

export type GhOption = { value: string; label: { key: 'ambient' } | { key: 'unavailable' | 'keyring'; user: string; host: string } | { key: 'env'; user: string; host: string; token: string }; disabled: boolean };

/** The choices, Orca's way: the ambient login, a bound login that is gone (shown, not choosable), then every login; env-token logins and a gh that can't bind are not choosable. */
export function ghOptions(inv: GhInventory | null, bound: GhBinding | null): GhOption[] {
	const accounts = inv?.accounts ?? [];
	const blocked = !inv || inv.capability !== 'supported';
	const out: GhOption[] = [{ value: AMBIENT, label: { key: 'ambient' }, disabled: false }];
	if (bound && !accounts.some((a) => accountKey(a) === accountKey(bound))) out.push({ value: accountKey(bound), label: { key: 'unavailable', user: bound.user, host: bound.host }, disabled: true });
	for (const a of accounts) {
		out.push({
			value: accountKey(a),
			label: a.source === 'keyring' ? { key: 'keyring', user: a.user, host: a.host } : { key: 'env', user: a.user, host: a.host, token: a.envToken ?? 'env' },
			disabled: a.source !== 'keyring' || blocked
		});
	}
	return out;
}

/** The suggestion worth showing: a choosable login other than the one bound. */
export function suggestion(inv: GhInventory | null, bound: GhBinding | null): GhBinding | null {
	const s = inv?.suggested ?? null;
	if (!s || inv?.capability !== 'supported') return null;
	return bound && accountKey(bound) === accountKey(s) ? null : s;
}

/** The setting's value as a binding (anything else: none). */
export function readBinding(v: unknown): GhBinding | null {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
	const { host, user } = v as Record<string, unknown>;
	return typeof host === 'string' && typeof user === 'string' && host.trim() && user.trim() ? { host: host.trim().toLowerCase(), user: user.trim() } : null;
}
