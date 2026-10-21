// The sign-ins Orca's other usage providers read (Settings › Stats & Usage). Keys and cookies a
// user pastes go straight to Rust and into the Keychain (usage/secrets.rs); this side only learns
// which are saved. The rest are other programs' own sign-ins, read in place and never copied.

import { invoke } from '@tauri-apps/api/core';
import type { ProviderId } from './usage.ts';

export const SECRET_IDS = ['opencode.apiKey', 'opencode.cookie', 'minimax.apiKey', 'minimax.cookie', 'zcode.apiKey'] as const;
export type SecretId = (typeof SECRET_IDS)[number];
export type SecretStatus = Record<SecretId, boolean>;

type LabelKey = 'usage.cred.opencodeKey' | 'usage.cred.opencodeCookie' | 'usage.cred.minimaxKey' | 'usage.cred.minimaxCookie' | 'usage.cred.zcodeKey';
export type SecretField = { id: SecretId; provider: ProviderId; label: LabelKey; hint: `${LabelKey}Hint`; settings: string[] };

/** One field per credential, under its provider, with the non-secret settings that go with it. */
export const SECRET_FIELDS: SecretField[] = [
	{ id: 'opencode.apiKey', provider: 'opencode', label: 'usage.cred.opencodeKey', hint: 'usage.cred.opencodeKeyHint', settings: [] },
	{ id: 'opencode.cookie', provider: 'opencode', label: 'usage.cred.opencodeCookie', hint: 'usage.cred.opencodeCookieHint', settings: ['kingu.usage.opencode.workspaceId'] },
	{ id: 'minimax.apiKey', provider: 'minimax', label: 'usage.cred.minimaxKey', hint: 'usage.cred.minimaxKeyHint', settings: [] },
	{ id: 'minimax.cookie', provider: 'minimax', label: 'usage.cred.minimaxCookie', hint: 'usage.cred.minimaxCookieHint', settings: ['kingu.usage.minimax.endpoint', 'kingu.usage.minimax.groupId', 'kingu.usage.minimax.models'] },
	{ id: 'zcode.apiKey', provider: 'zcode', label: 'usage.cred.zcodeKey', hint: 'usage.cred.zcodeKeyHint', settings: ['kingu.usage.zcode.site'] }
];

/** Providers that read another program's sign-in: what to run, nothing to paste. */
export const CLI_SIGN_INS: { provider: ProviderId; hint: 'usage.cli.cursor' | 'usage.cli.grok' | 'usage.cli.kimi' | 'usage.cli.antigravity' }[] = [
	{ provider: 'cursor', hint: 'usage.cli.cursor' },
	{ provider: 'grok', hint: 'usage.cli.grok' },
	{ provider: 'kimi', hint: 'usage.cli.kimi' },
	{ provider: 'antigravity', hint: 'usage.cli.antigravity' }
];

/** Rust's answer as a full map (a missing id is not saved). */
export function toStatus(raw: Record<string, boolean> | null | undefined): SecretStatus {
	return Object.fromEntries(SECRET_IDS.map((id) => [id, raw?.[id] === true])) as SecretStatus;
}

export async function loadSecretStatus(): Promise<SecretStatus> {
	return toStatus(await invoke<Record<string, boolean>>('usage_secret_status').catch(() => null));
}

/** Saves `value` for `id` (Rust trims it; an empty one removes the item). */
export function saveSecret(id: SecretId, value: string): Promise<void> {
	return invoke('usage_secret_set', { id, value });
}

/** A pasted value Rust would refuse or store wrongly: empty, or several lines. */
export const pastable = (value: string) => value.trim().length > 0 && !/[\r\n]/.test(value.trim());
