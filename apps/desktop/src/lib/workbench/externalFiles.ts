// Files outside the open folder (VS Code's File: Open File… on any path). Their editor key is
// `external:<absolute path>`; Rust reads and saves them only after the user picked them in its
// Open File dialog (external.rs). Pure, so bun tests can check it.

export const EXTERNAL_PREFIX = 'external:';
export const externalKey = (absolute: string) => EXTERNAL_PREFIX + absolute;
export const isExternalKey = (key: string) => key.startsWith(EXTERNAL_PREFIX);
export const externalPath = (key: string) => key.slice(EXTERNAL_PREFIX.length);

/** `absolute` relative to `root` ('a/b.ts'), or null when it is not inside it. */
export function relativeTo(absolute: string, root: string | null): string | null {
	if (!root) return null;
	const base = root.replace(/\/+$/, '');
	if (!absolute.startsWith(base + '/')) return null;
	const rel = absolute.slice(base.length + 1);
	return rel && !rel.split('/').includes('..') ? rel : null;
}

/** The editor key to open a picked file with: a workspace path inside the folder, else external. */
export const editorKeyFor = (absolute: string, root: string | null) => relativeTo(absolute, root) ?? externalKey(absolute);

/** `~/…` for paths under the home folder, like VS Code's tab descriptions and Open Recent. */
export function tildify(path: string, home: string): string {
	const h = home.replace(/\/+$/, '');
	return h && (path === h || path.startsWith(h + '/')) ? '~' + path.slice(h.length) : path;
}

/** The tab description of an external file: its folder (VS Code shows the parent's path for files outside the workspace). */
export function externalDescription(key: string, home: string): string {
	const path = externalPath(key);
	return tildify(path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/', home);
}

/** Breadcrumbs of an external file: the folders of its path, then its name. */
export const externalCrumbs = (key: string) => externalPath(key).split('/').filter(Boolean);
