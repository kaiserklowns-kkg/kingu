// Plain-data pieces of the LSP integration (server table, diagnostics index, status text),
// kept out of the Svelte store so `bun test` can cover them.

import type { ServerStatus } from './client';
import { mergeDiagnostics, relOfUri, uriToPath } from './convert';
import type { Diagnostic } from './protocol';

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
};

/** Mirrors `spec_for` in src-tauri/src/lsp.rs. Keys are what `lsp_start` accepts. */
export const SERVERS: ServerInfo[] = [
	{ key: 'rust', name: 'rust-analyzer', languages: ['rust'] },
	{ key: 'typescript', name: 'TypeScript language server', languages: ['typescript', 'javascript'], yieldsBuiltin: true },
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
		yieldsBuiltin: true
	},
	{ key: 'css', name: 'CSS language server', languages: ['css', 'scss', 'less'], initializationOptions: { provideFormatter: true }, yieldsBuiltin: true },
	{
		key: 'html',
		name: 'HTML language server',
		languages: ['html'],
		initializationOptions: { provideFormatter: true, embeddedLanguages: { css: true, javascript: true }, configurationSection: ['html', 'css', 'javascript'] },
		yieldsBuiltin: true
	},
	{
		key: 'yaml',
		name: 'YAML language server',
		languages: ['yaml'],
		settings: {
			yaml: { validate: true, hover: true, completion: true, format: { enable: true }, schemaStore: { enable: true, url: 'https://www.schemastore.org/api/json/catalog.json' } },
			http: { proxy: '', proxyStrictSSL: true }
		}
	},
	{ key: 'toml', name: 'Taplo', languages: ['toml'] }
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
	return info.methods.map((m, i) => ({ id: String(i), label: m.argv.map(shellWord).join(' '), description: i === 0 ? 'แนะนำ' : undefined }));
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
			return `${server.name}: starting…`;
		case 'indexing':
			return `${server.name}: ${status.message ? status.message : 'indexing'}…`;
		case 'ready':
			return `${server.name}: ready`;
		case 'not-installed':
			return `ไม่ได้ติดตั้ง ${server.name}`;
		case 'stopped':
			return `${server.name}: stopped`;
		case 'error':
			return `${server.name}: error`;
	}
}

export type ProblemFile = {
	uri: string;
	/** Workspace-relative path when the file can be opened, else null. */
	rel: string | null;
	/** What the Problems panel shows: the relative path, or the absolute one outside the workspace. */
	label: string;
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

	files(root: string): ProblemFile[] {
		const out: ProblemFile[] = [];
		for (const uri of this.#byUri.keys()) {
			const items = this.get(uri);
			if (!items.length) continue;
			const rel = relOfUri(root, uri);
			out.push({ uri, rel, label: rel ?? uriToPath(uri) ?? uri, items });
		}
		// Workspace files first, then by path (VS Code sorts the Problems tree by resource).
		return out.sort((a, b) => Number(a.rel === null) - Number(b.rel === null) || a.label.localeCompare(b.label));
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
