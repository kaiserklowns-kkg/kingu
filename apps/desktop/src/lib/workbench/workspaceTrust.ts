// Workspace Trust (VS Code's workspaceTrust.ts, docs editing/workspaces/workspace-trust.md): pure
// rules for workspaceTrust.svelte.ts. A trusted folder trusts everything under it; a workspace is
// trusted when each root folder is (and its saved `.code-workspace` file); an empty window follows
// `security.workspace.trust.emptyWindow` unless "Don't Trust" was picked for this session.

/** `security.workspace.trust.*` (all user-only). */
export type TrustSettings = {
	enabled: boolean;
	startupPrompt: 'always' | 'once' | 'never';
	banner: 'always' | 'untilDismissed' | 'never';
	untrustedFiles: 'prompt' | 'open' | 'newWindow';
	emptyWindow: boolean;
};

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** `path` is `folder` or inside it (whole path segments: `/a/bc` is not in `/a/b`). */
export function within(path: string, folder: string): boolean {
	const p = trimSlash(path);
	const f = trimSlash(folder);
	if (!f) return false;
	return p === f || p.startsWith(f === '/' ? '/' : f + '/');
}

/** The trusted entry covering `path`: itself or its nearest trusted parent (longest match), or null. */
export function trustedBy(path: string, trusted: readonly string[]): string | null {
	let best: string | null = null;
	for (const t of trusted) if (within(path, t) && (best === null || trimSlash(t).length > trimSlash(best).length)) best = t;
	return best;
}

export type TrustInput = {
	settings: Pick<TrustSettings, 'enabled' | 'emptyWindow'>;
	/** The window's root folders (absolute). */
	folders: readonly string[];
	/** Its saved `.code-workspace` file, if any (an untitled workspace has none). */
	workspaceFile: string | null;
	trusted: readonly string[];
	/** An empty window's trust picked for this session in the Workspace Trust editor. */
	emptyOverride?: boolean | null;
};

export type TrustState = {
	trusted: boolean;
	/** Trust is off (`security.workspace.trust.enabled: false`): everything is trusted. */
	disabled: boolean;
	/** The workspace has no folder. */
	empty: boolean;
	/** The folders trusted because a parent folder is (VS Code then shows no "Don't Trust"), by folder. */
	inherited: Record<string, string>;
	/** Folders (and the workspace file) that are not trusted. */
	untrusted: string[];
};

/** Whether the window is trusted, and why. */
export function resolveTrust(i: TrustInput): TrustState {
	const empty = i.folders.length === 0;
	if (!i.settings.enabled) return { trusted: true, disabled: true, empty, inherited: {}, untrusted: [] };
	if (empty) return { trusted: i.emptyOverride ?? i.settings.emptyWindow, disabled: false, empty, inherited: {}, untrusted: [] };
	const inherited: Record<string, string> = {};
	const untrusted: string[] = [];
	for (const p of i.workspaceFile ? [...i.folders, i.workspaceFile] : i.folders) {
		const by = trustedBy(p, i.trusted);
		if (by === null) untrusted.push(p);
		else if (trimSlash(by) !== trimSlash(p)) inherited[p] = by;
	}
	return { trusted: untrusted.length === 0, disabled: false, empty, inherited, untrusted };
}

/** The trusted list with `paths` added (each once, absolute only). */
export function addTrusted(list: readonly string[], paths: readonly string[]): string[] {
	const out = [...list];
	for (const p of paths.map(trimSlash)) if (p.startsWith('/') && !out.some((o) => trimSlash(o) === p)) out.push(p);
	return out;
}

/** The trusted list without `paths` (a parent that trusts them stays: remove it by itself). */
export function removeTrusted(list: readonly string[], paths: readonly string[]): string[] {
	const gone = new Set(paths.map(trimSlash));
	return list.filter((p) => !gone.has(trimSlash(p)));
}

/** The folder above `path` (`/` stays `/`). */
export function parentOf(path: string): string {
	const p = trimSlash(path);
	const i = p.lastIndexOf('/');
	return i <= 0 ? '/' : p.slice(0, i);
}

/**
 * Whether opening an untrusted workspace asks right away (`startupPrompt`): `always`, `once`
 * per workspace (`prompted`: asked before), `never` (Restricted Mode with the banner only).
 */
export function shouldPrompt(s: Pick<TrustSettings, 'enabled' | 'startupPrompt'>, state: TrustState, prompted: boolean): boolean {
	if (!s.enabled || state.trusted || state.empty) return false;
	return s.startupPrompt === 'always' || (s.startupPrompt === 'once' && !prompted);
}

/** Whether the Restricted Mode banner shows (`banner`; `untilDismissed`: until closed in this workspace). */
export function showBanner(s: Pick<TrustSettings, 'banner'>, state: TrustState, dismissed: boolean): boolean {
	if (state.trusted || s.banner === 'never') return false;
	return s.banner === 'always' || !dismissed;
}

/**
 * Opening files from outside the trusted folders in a trusted window (`untrustedFiles`; an empty
 * trusted window too): `open` as usual, `newWindow` in a new Restricted Mode window, `prompt` ask
 * (once per workspace: `accepted` when untrusted files were let in before).
 */
export function untrustedFilesAction(s: Pick<TrustSettings, 'enabled' | 'untrustedFiles'>, state: TrustState, files: readonly string[], trusted: readonly string[], accepted: boolean): 'open' | 'prompt' | 'newWindow' {
	if (!s.enabled || !state.trusted || state.disabled) return 'open';
	if (files.every((f) => trustedBy(f, trusted) !== null)) return 'open';
	if (s.untrustedFiles === 'prompt') return accepted ? 'open' : 'prompt';
	return s.untrustedFiles;
}

/** Reads the settings with VS Code's defaults for anything missing or invalid. */
export function trustSettings(get: (id: string) => unknown): TrustSettings {
	const pick = <T extends string>(id: string, values: readonly T[], fallback: T): T => {
		const v = get(id);
		return values.includes(v as T) ? (v as T) : fallback;
	};
	const bool = (id: string, fallback: boolean) => {
		const v = get(id);
		return typeof v === 'boolean' ? v : fallback;
	};
	return {
		enabled: bool('security.workspace.trust.enabled', true),
		startupPrompt: pick('security.workspace.trust.startupPrompt', ['always', 'once', 'never'], 'never'),
		banner: pick('security.workspace.trust.banner', ['always', 'untilDismissed', 'never'], 'untilDismissed'),
		untrustedFiles: pick('security.workspace.trust.untrustedFiles', ['prompt', 'open', 'newWindow'], 'prompt'),
		emptyWindow: bool('security.workspace.trust.emptyWindow', true)
	};
}
