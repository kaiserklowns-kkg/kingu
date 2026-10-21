// Plain-data pieces of the LSP integration (server table, diagnostics index, status text),
// kept out of the Svelte store so `bun test` can cover them.

import type { ServerStatus } from './client';
import { keyOfUri, mergeDiagnostics, uriToPath } from './convert';
import { problemLabel } from './folders';
import type { WorkspaceFolder } from '#lib/workbench/workspaceFolders.ts';
import type { Diagnostic } from './protocol';
import { t } from '#lib/i18n/index.ts';

export type ServerInfo = {
	key: string;
	name: string;
	/** Monaco language ids it serves; the first is what `lsp_start` is given. */
	languages: string[];
	/** `initialize` params' `initializationOptions`. */
	initializationOptions?: unknown;
	/** Answers `workspace/configuration` (by section), and is pushed with
	 * `workspace/didChangeConfiguration` after `initialized` for servers that only read pushed
	 * settings (the JSON server). */
	settings?: Record<string, unknown>;
	/** Monaco's own language service for these ids gives way once the server is ready, so hovers
	 * and completions do not show twice. */
	yieldsBuiltin?: boolean;
	/** One server for every root folder even when it cannot take several: it works per file
	 * (tsserver finds each file's tsconfig, the JSON/CSS/HTML/YAML/TOML servers need no root), as
	 * VS Code runs one of these for the whole workspace. Others get a server per folder then. */
	oneServer?: boolean;
};

/** Mirrors `spec_for` in src-tauri/src/lsp.rs. Keys are what `lsp_start` accepts. */
export const SERVERS: ServerInfo[] = [
	{ key: 'rust', name: 'rust-analyzer', languages: ['rust'] },
	{ key: 'typescript', name: 'TypeScript language server', languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'], yieldsBuiltin: true, oneServer: true },
	{ key: 'go', name: 'gopls', languages: ['go'] },
	{
		key: 'svelte',
		name: 'Svelte language server',
		languages: ['svelte'],
		// Read once at startup; some versions fail on a missing `typescript`/`javascript` section,
		// so every section is present (empty means defaults).
		initializationOptions: {
			configuration: { svelte: { plugin: {} }, typescript: {}, javascript: {}, css: {}, scss: {}, less: {}, html: {}, emmet: {}, prettier: {} },
			// Monaco filters completion lists itself, as VS Code does.
			dontFilterIncompleteCompletions: true
		}
	},
	{ key: 'python', name: 'basedpyright', languages: ['python'] },
	{
		key: 'json',
		name: 'JSON language server',
		languages: ['json'],
		initializationOptions: { provideFormatter: true },
		// `json.schemas` gets Kingu's settings schema added in lsp.svelte.ts.
		settings: {
			json: { validate: { enable: true }, format: { enable: true }, schemas: [] },
			http: { proxy: '', proxyStrictSSL: true }
		},
		yieldsBuiltin: true,
		oneServer: true
	},
	{ key: 'css', name: 'CSS language server', languages: ['css', 'scss', 'less'], initializationOptions: { provideFormatter: true }, yieldsBuiltin: true, oneServer: true },
	{
		key: 'html',
		name: 'HTML language server',
		languages: ['html'],
		initializationOptions: { provideFormatter: true, embeddedLanguages: { css: true, javascript: true }, configurationSection: ['html', 'css', 'javascript'] },
		yieldsBuiltin: true,
		oneServer: true
	},
	{
		key: 'yaml',
		name: 'YAML language server',
		languages: ['yaml'],
		settings: {
			yaml: { validate: true, hover: true, completion: true, format: { enable: true }, schemaStore: { enable: true, url: 'https://www.schemastore.org/api/json/catalog.json' } },
			http: { proxy: '', proxyStrictSSL: true }
		},
		oneServer: true
	},
	{ key: 'toml', name: 'Taplo', languages: ['toml'], oneServer: true }
];

export function serverFor(languageId: string): ServerInfo | undefined {
	return SERVERS.find((s) => s.languages.includes(languageId));
}

/** `kingu.lsp.disabled`: comma- or space-separated server keys or language ids. */
export function parseDisabled(value: unknown): Set<string> {
	return new Set(typeof value === 'string' ? value.split(/[\s,]+/).map((s) => s.toLowerCase()).filter(Boolean) : []);
}

export function isDisabled(info: ServerInfo, disabled: Set<string>): boolean {
	return disabled.has(info.key) || info.languages.some((l) => disabled.has(l));
}

/** `lsp_install_methods` (src-tauri/src/lsp.rs `InstallInfo`). */
export type InstallMethod = { tool: string; argv: string[] };
export type InstallInfo = { server: string; binary: string; methods: InstallMethod[] };

/** Quick pick items for installing a server; ids index `info.methods`. */
export function installItems(info: InstallInfo): { id: string; label: string; description?: string }[] {
	return info.methods.map((m, i) => ({ id: String(i), label: m.argv.map(shellWord).join(' '), description: i === 0 ? t('tools.lsp.recommended') : undefined }));
}

/** How a word reads on a shell command line (display only; the terminal quotes argv itself). */
export function shellWord(w: string): string {
	return /^[\w@%+=:,./~-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`;
}

/** `workspace/configuration` for an unknown section is an empty object, so servers that read
 * properties off it (yaml, svelte, pyright) get their defaults instead of failing on null. */
export function configurationValue(settings: Record<string, unknown>, section?: string): unknown {
	return configSection(settings, section) ?? {};
}

export function statusText(server: ServerInfo, status: ServerStatus | undefined): string {
	switch (status?.state) {
		case undefined:
			return '';
		case 'starting':
			return t('tools.lsp.status.starting', { name: server.name });
		case 'indexing':
			return status.message ? t('tools.lsp.status.indexingMessage', { name: server.name, message: status.message }) : t('tools.lsp.status.indexing', { name: server.name });
		case 'ready':
			return t('tools.lsp.status.ready', { name: server.name });
		case 'not-installed':
			return t('tools.lsp.status.notInstalled', { name: server.name });
		case 'stopped':
			return t('tools.lsp.status.stopped', { name: server.name });
		case 'error':
			return t('tools.lsp.status.error', { name: server.name });
	}
}

export type ProblemFile = {
	uri: string;
	/** Workspace-relative path when the file can be opened, else null. */
	rel: string | null;
	/** What the Problems panel shows: the path relative to its root folder, or the absolute one outside the workspace. */
	label: string;
	/** Beside it: the directory, led by the root folder's name in a multi-root window (VS Code's label service). */
	detail: string;
	items: Diagnostic[];
};

export type Counts = { errors: number; warnings: number; infos: number };

export class DiagnosticsIndex {
	#byUri = new Map<string, { push?: Diagnostic[]; pull?: Diagnostic[] }>();

	/** Returns the merged diagnostics now in effect for `uri`. */
	set(uri: string, kind: 'push' | 'pull', items: Diagnostic[]): Diagnostic[] {
		const entry = this.#byUri.get(uri) ?? {};
		entry[kind] = items;
		const merged = mergeDiagnostics(entry.push, entry.pull);
		if (merged.length || entry.push?.length || entry.pull?.length) this.#byUri.set(uri, entry);
		else this.#byUri.delete(uri);
		return merged;
	}

	get(uri: string): Diagnostic[] {
		const e = this.#byUri.get(uri);
		return e ? mergeDiagnostics(e.push, e.pull) : [];
	}

	/** Forgets everything under the URIs `owned` returns true for (a server that went away). */
	clear(owned: (uri: string) => boolean): string[] {
		const gone = [...this.#byUri.keys()].filter(owned);
		gone.forEach((u) => this.#byUri.delete(u));
		return gone;
	}

	/** The Problems panel's files; `extra` adds problems of other owners (task problem matchers).
	 * `rel` is the workbench key in `root` (one folder) or in the workspace's root folders. */
	files(root: string | readonly WorkspaceFolder[], extra?: OwnedDiagnostics): ProblemFile[] {
		const folders = typeof root === 'string' ? (root ? [{ path: root, name: '' }] : []) : root;
		const out: ProblemFile[] = [];
		for (const uri of new Set([...this.#byUri.keys(), ...(extra?.uris() ?? [])])) {
			const items = extra ? mergeDiagnostics(this.get(uri), extra.get(uri)) : this.get(uri);
			if (!items.length) continue;
			const rel = keyOfUri(folders, uri);
			out.push({ uri, rel, ...problemLabel(rel, uriToPath(uri) ?? uri, folders), items });
		}
		// Workspace files first, then by path (VS Code sorts the Problems tree by resource).
		const path = (f: ProblemFile) => uriToPath(f.uri) ?? f.uri;
		return out.sort((a, b) => Number(a.rel === null) - Number(b.rel === null) || path(a).localeCompare(path(b)));
	}
}

/** Problems from sources other than language servers (VS Code's markers of other owners, e.g. a
 * task's problem matcher `$tsc` under owner `typescript`), by owner and file URI. */
export class OwnedDiagnostics {
	#byOwner = new Map<string, Map<string, Diagnostic[]>>();

	set(owner: string, uri: string, items: Diagnostic[]) {
		let perOwner = this.#byOwner.get(owner);
		if (!perOwner) this.#byOwner.set(owner, (perOwner = new Map()));
		if (items.length) perOwner.set(uri, items);
		else perOwner.delete(uri);
		if (!perOwner.size) this.#byOwner.delete(owner);
	}

	/** URIs with problems of `owner`, or of any owner. */
	uris(owner?: string): string[] {
		if (owner !== undefined) return [...(this.#byOwner.get(owner)?.keys() ?? [])];
		return [...new Set([...this.#byOwner.values()].flatMap((m) => [...m.keys()]))];
	}

	owners(): string[] {
		return [...this.#byOwner.keys()];
	}

	forOwner(owner: string, uri: string): Diagnostic[] {
		return this.#byOwner.get(owner)?.get(uri) ?? [];
	}

	get(uri: string): Diagnostic[] {
		return [...this.#byOwner.values()].flatMap((m) => m.get(uri) ?? []);
	}

	clear() {
		this.#byOwner.clear();
	}
}

/** `workspace/configuration`: the value at a dotted `section` of `settings` (VS Code's
 * `getConfiguration(section)`), the whole object without a section, null when absent. */
export function configSection(settings: Record<string, unknown>, section?: string): unknown {
	if (!section) return settings;
	if (section in settings) return settings[section];
	let v: unknown = settings;
	for (const key of section.split('.')) {
		if (v === null || typeof v !== 'object' || !(key in v)) return null;
		v = (v as Record<string, unknown>)[key];
	}
	return v ?? null;
}

/** A busy server for the status bar ("rust-analyzer: Indexing (40%)…"), null when idle. */
export function progressText(server: ServerInfo, status: ServerStatus | undefined): string | null {
	if (status?.state !== 'indexing' && status?.state !== 'starting') return null;
	return statusText(server, status);
}

export function countDiagnostics(files: ProblemFile[]): Counts {
	const c: Counts = { errors: 0, warnings: 0, infos: 0 };
	for (const f of files)
		for (const d of f.items) {
			if (d.severity === 2) c.warnings++;
			else if (d.severity === 3 || d.severity === 4) c.infos++;
			else c.errors++;
		}
	return c;
}
