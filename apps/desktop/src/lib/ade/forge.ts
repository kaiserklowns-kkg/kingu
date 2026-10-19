// The code host of a folder's pull requests: GitHub, or GitLab, where they are merge requests
// (Rust `agent/forge.rs` and `agent/mr.rs` answer both in gh's shapes). ft() picks a message's
// `.github` or `.gitlab` twin from the forge catalog, so text says "Merge Request" and "GitLab"
// where the repository is on GitLab.
import { t, type MessageKey } from '#lib/i18n/index.ts';
import type { GhStatus } from './model';

export type Forge = 'github' | 'gitlab';

/** The host of a pull request link: a GitLab merge request's has `/-/merge_requests/`. */
export function forgeOfUrl(url: string | null | undefined): Forge | null {
	if (!url) return null;
	if (/^https:\/\/[^/]+\/.+?\/-\/merge_requests\/\d+/.test(url)) return 'gitlab';
	return /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+/.test(url) ? 'github' : null;
}

/** The open folder's host from `gh_status` (GitHub until it says otherwise). */
export const forgeOf = (gh: Pick<GhStatus, 'provider'> | null | undefined): Forge => (gh?.provider === 'gitlab' ? 'gitlab' : 'github');

/** The host of a PR: its link when known, else the folder's. */
export const forgeFor = (url: string | null | undefined, gh: Pick<GhStatus, 'provider'> | null | undefined): Forge => forgeOfUrl(url) ?? forgeOf(gh);

/** Message keys with both a `.github` and a `.gitlab` twin, without the suffix. */
export type ForgeKey = { [K in MessageKey]: K extends `${infer B}.github` ? (`${B}.gitlab` extends MessageKey ? B : never) : never }[MessageKey];

/** t() of `key`'s twin for `forge` (the twins take the same params; i18n.test checks them). */
export function ft<B extends ForgeKey>(key: B, forge: Forge, ...args: Parameters<typeof t<`${B}.github`>> extends [unknown, ...infer P] ? P : never): string {
	return (t as (key: MessageKey, ...rest: unknown[]) => string)(`${key}.${forge}` as MessageKey, ...args);
}
