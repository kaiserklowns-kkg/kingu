// Plain-data pieces of the LSP integration (server table, diagnostics index, status text),
// kept out of the Svelte store so `bun test` can cover them.

import type { ServerStatus } from './client';
import { mergeDiagnostics, relOfUri, uriToPath } from './convert';
import type { Diagnostic } from './protocol';

export type ServerInfo = { key: string; name: string; languages: string[] };

/** Mirrors `spec_for` in src-tauri/src/lsp.rs. Keys are what `lsp_start` accepts. */
export const SERVERS: ServerInfo[] = [
	{ key: 'rust', name: 'rust-analyzer', languages: ['rust'] },
	{ key: 'typescript', name: 'TypeScript language server', languages: ['typescript', 'javascript'] },
	{ key: 'go', name: 'gopls', languages: ['go'] }
];

export function serverFor(languageId: string): ServerInfo | undefined {
	return SERVERS.find((s) => s.languages.includes(languageId));
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
			return `${server.name} not installed`;
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
