// "Used N references" above a response (VS Code's chatReferencesContentPart): the files the agent
// looked at in that turn, from its Read calls and the files its Grep and Glob calls found, its
// subagents' included. Edited files are not references (the edit pills show them). Pure, so
// `bun test` covers it.

import type { Part } from './chatParts.ts';

export type Reference = {
	/** As the tool gave it (absolute, or relative to where the agent runs). */
	path: string;
	/** 1-based line a Grep match or a ranged Read starts at. */
	line?: number;
};

/** At most this many references per response (a wide Glob lists hundreds). */
export const MAX_REFERENCES = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

/**
 * A Grep / Glob result's file lines: `path` (files_with_matches, Glob), `path:12:text` (content
 * mode) or `path-12-text` context lines are not files; summaries ("Found 3 files", "No files
 * found", "(Results are truncated…)") are left out.
 */
export function resultPaths(content: string): Reference[] {
	const out: Reference[] = [];
	for (const raw of content.split('\n')) {
		const line = raw.trim();
		if (!line || /^(found \d+|no (files|matches) found|\(results are truncated)/i.test(line) || /^\d+$/.test(line)) continue;
		const match = /^(.+?):(\d+):/.exec(line);
		if (!match && /-\d+-/.test(line) && /\s/.test(line)) continue;
		const path = match ? match[1] : line;
		// A file path has a slash or a dot; one with spaces must be absolute (not a sentence).
		if (!/[/.]/.test(path) || path.length > 1024 || (/\s/.test(path) && !path.startsWith('/'))) continue;
		out.push(match ? { path, line: Number(match[2]) } : { path });
	}
	return out;
}

/** The references of a response's parts, first use first, one per file. */
export function turnReferences(parts: readonly Part[], max = MAX_REFERENCES): Reference[] {
	const seen = new Set<string>();
	const out: Reference[] = [];
	const add = (r: Reference) => {
		if (seen.has(r.path) || out.length >= max) return;
		seen.add(r.path);
		out.push(r);
	};
	const walk = (list: readonly Part[]) => {
		for (const p of list) {
			if (p.kind !== 'tool') continue;
			const input = isRecord(p.input) ? p.input : {};
			if (READ_TOOLS.has(p.name)) {
				const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
				const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : undefined;
				if (path && !p.result?.isError) add(offset ? { path, line: offset } : { path });
			} else if (SEARCH_TOOLS.has(p.name) && p.result && !p.result.isError) {
				for (const r of resultPaths(p.result.content)) add(r);
			}
			if (p.children) walk(p.children);
		}
	};
	walk(parts);
	return out;
}

/** A reference's file name and the folder it is in, for its pill. */
export function referenceLabel(path: string): { name: string; dir: string } {
	const clean = path.replace(/\/+$/, '');
	const i = clean.lastIndexOf('/');
	return i < 0 ? { name: clean, dir: '' } : { name: clean.slice(i + 1), dir: clean.slice(0, i) };
}
