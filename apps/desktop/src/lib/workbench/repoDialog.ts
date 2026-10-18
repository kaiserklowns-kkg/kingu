import { t } from '#lib/i18n/index.ts';
// Pure parts of the Clone Repository / New Project dialog (Orca's Add Project: clone and create
// steps). Rust validates again (`CloneUrl::parse`, `project::create`); this only gives feedback
// while typing. Free of runes so `bun test` covers it.

/** Why `input` cannot be cloned, or null. https, ssh and `user@host:path` only, as Rust allows. */
export function cloneUrlError(input: string): string | null {
	const url = input.trim();
	if (!url) return t('workbench.repoDialog.enterUrl');
	const invalid = () => t('workbench.repoDialog.invalidUrl');
	if (/\s/.test(url) || url.startsWith('-') || url.includes('#')) return invalid();
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (scheme) {
		const s = scheme[1].toLowerCase();
		if (s !== 'https' && s !== 'ssh') return t('workbench.repoDialog.unsupportedScheme', { scheme: s });
		const host = url.slice(scheme[0].length).split('/')[0].split('@').pop() ?? '';
		if (!host || host.startsWith('-') || !url.slice(scheme[0].length).includes('/')) return invalid();
		return null;
	}
	if (url.includes('::')) return invalid();
	const scp = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+):(.+)$/.exec(url);
	if (scp && !scp[2].startsWith('-') && !(scp[1] ?? '').startsWith('-')) return null;
	return invalid();
}

/** The folder git clones into: the URL's last segment without `.git` (Orca's rule). */
export function repoNameFromUrl(input: string): string {
	const source = input.trim().replace(/\/+$/, '').replace(/\.git$/, '');
	const name = source.split(/[/:]/).pop() ?? '';
	return name === '.' || name === '..' ? '' : name;
}

/** Why `name` cannot be a project folder name, or null (Orca's create step rules). */
export function projectNameError(name: string): string | null {
	const n = name.trim();
	if (!n) return t('workbench.repoDialog.enterName');
	if (/[\\/]/.test(n) || n === '.' || n === '..') return t('workbench.repoDialog.nameSlash');
	if (n.startsWith('-')) return t('workbench.repoDialog.nameDash');
	return null;
}

/** Orca's defaults: clones beside the worktrees folder (`~/kingu`), new projects in `~/kingu/projects`. */
export function defaultParents(home: string): { clone: string; project: string } {
	const h = home.replace(/\/+$/, '');
	return { clone: `${h}/kingu`, project: `${h}/kingu/projects` };
}

/** `git.defaultCloneDirectory` (`~` is the home folder), else Kingu's default. */
export function cloneParent(setting: string | null | undefined, home: string): string {
	const dir = (setting ?? '').trim();
	if (!dir) return defaultParents(home).clone;
	return dir === '~' ? home : dir.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${dir.slice(2)}` : dir;
}

/** `git.openAfterClone`: open the clone, ask first, or leave the current folder open. */
export function afterClone(mode: string, folderOpen: boolean): 'open' | 'ask' | 'stay' {
	// Kingu has one window: alwaysNewWindow opens the clone in it.
	if (mode === 'always' || mode === 'alwaysNewWindow') return 'open';
	if (mode === 'whenNoFolderOpen') return folderOpen ? 'stay' : 'open';
	return 'ask';
}

export type CloneProgress = { phase: string; percent: number };

/** `Receiving objects 42%`. */
export function progressLabel(p: CloneProgress | null): string {
	return p ? `${p.phase} ${p.percent}%` : t('workbench.repoDialog.startingClone');
}
