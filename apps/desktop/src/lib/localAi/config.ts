// What the Rust side of Local AI (src-tauri/src/local_ai) takes from settings, and the pure bits
// of the editor provider. Pure, so `bun test` covers it.

import { searchSettingsFrom } from '#lib/settings/mappings.ts';

type Get = <T = unknown>(id: string) => T;

export type Provider = 'ollama' | 'openai';

/** Rust `http::Endpoint`. */
export type Endpoint = { provider: Provider; url: string; api_key: string };

/** Rust `completions::CompletionRequest`. */
export type CompletionRequest = {
	id: number;
	endpoint: Endpoint;
	model: string;
	template: string;
	prefix: string;
	suffix: string;
	max_tokens: number;
};

/** Rust `semantic::SemanticConfig`. */
export type SemanticConfig = {
	enabled: boolean;
	endpoint: Endpoint;
	model: string;
	exclude_globs: string[];
	use_ignore_files: boolean;
};

/** Rust `semantic::Status`. */
export type SemanticStatus = {
	state: 'idle' | 'building' | 'ready' | 'error';
	done: number;
	total: number;
	files: number;
	chunks: number;
	limited: boolean;
	error: string | null;
};

/** Rust `semantic::Hit`: `line`, `start_line` and `end_line` are 1-based. */
export type SemanticHit = { path: string; line: number; text: string; start_line: number; end_line: number; score: number };

export type SemanticResult = { hits: SemanticHit[]; status: SemanticStatus };

/** The code read around the cursor: 80 lines before it, 30 after (old Kingu's window). */
export const LINES_BEFORE = 80;
export const LINES_AFTER = 30;

export function endpointFrom(get: Get): Endpoint {
	return {
		provider: get<string>('kingu.completions.provider') === 'openai' ? 'openai' : 'ollama',
		url: (get<string>('kingu.completions.endpoint') ?? '').trim(),
		api_key: get<string>('kingu.completions.apiKey') ?? ''
	};
}

export function completionRequest(get: Get, id: number, prefix: string, suffix: string): CompletionRequest {
	return {
		id,
		endpoint: endpointFrom(get),
		model: (get<string>('kingu.completions.model') ?? '').trim(),
		template: get<string>('kingu.completions.fimTemplate') ?? 'auto',
		prefix,
		suffix,
		max_tokens: get<number>('kingu.completions.maxTokens') ?? 64
	};
}

export function semanticConfigFrom(get: Get): SemanticConfig {
	const search = searchSettingsFrom(get, true);
	return {
		enabled: get<boolean>('kingu.semanticSearch.enabled') === true,
		endpoint: endpointFrom(get),
		model: (get<string>('kingu.semanticSearch.model') ?? '').trim(),
		exclude_globs: search.exclude_globs,
		use_ignore_files: get<boolean>('search.useIgnoreFiles') !== false
	};
}

/** Only real files get completions: not diff sides, git revisions or output views. */
export function completesScheme(scheme: string): boolean {
	return scheme === 'file';
}

/** What the status bar item shows. */
export type CompletionState = 'off' | 'idle' | 'loading' | 'error';

/** Resolves after `ms`, or early (false) once `cancelled` says so; checked every 25 ms. */
export function pause(ms: number, cancelled: () => boolean): Promise<boolean> {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			if (cancelled()) return resolve(false);
			if (Date.now() - started >= ms) return resolve(true);
			setTimeout(tick, Math.min(25, ms));
		};
		tick();
	});
}

/** A hit as a quick pick row: the shown line, then `path:line` and the score as a percentage. */
export function hitRow(hit: SemanticHit): { label: string; description: string } {
	return { label: hit.text || hit.path, description: `${hit.path}:${hit.line} · ${Math.round(hit.score * 100)}%` };
}
