// Local AI in the editor (old Kingu's kinguInlineCompletions.ts and semantic search), on the
// user's own model server through Rust (src-tauri/src/local_ai):
// - Grey-text completions: a Monaco inline completions provider, registered only while
//   kingu.completions.enabled is on (so nothing is sent while it is off). It waits for typing to
//   pause, sends the code around the cursor, and cancels the request when Monaco moves on; Tab
//   accepts and Escape dismisses (Monaco's own keys).
// - Semantic search: the index is brought up to date in the background while
//   kingu.semanticSearch.enabled is on and a folder is open; "Semantic Search" asks for a query
//   and lists the closest chunks.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { untrack } from 'svelte';
import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import {
	completesScheme,
	completionRequest,
	hitRow,
	LINES_AFTER,
	LINES_BEFORE,
	pause,
	semanticConfigFrom,
	type CompletionState,
	type SemanticResult,
	type SemanticStatus
} from './config';

const get = <T>(id: string) => settings.get<T>(id);

class LocalAi {
	/** The completions item's state. */
	state = $state<CompletionState>('off');
	error = $state('');
	/** The semantic index of the open folder, as Rust reports it. */
	semantic = $state.raw<SemanticStatus | null>(null);
	/** Requests in flight; `loading` while there is one. */
	#inFlight = 0;
	#seq = 0;

	get completionsOn() {
		return get<boolean>('kingu.completions.enabled') === true;
	}

	get semanticOn() {
		return get<boolean>('kingu.semanticSearch.enabled') === true;
	}

	/** Monaco's provider: asks Rust for the middle once typing pauses. */
	async provide(monaco: typeof Monaco, model: Monaco.editor.ITextModel, position: Monaco.Position, token: Monaco.CancellationToken): Promise<Monaco.languages.InlineCompletions> {
		const none = { items: [] };
		if (!this.completionsOn || !completesScheme(model.uri.scheme)) return none;
		if (!(await pause(get<number>('kingu.completions.debounce') ?? 300, () => token.isCancellationRequested))) return none;
		const last = model.getLineCount();
		const endLine = Math.min(last, position.lineNumber + LINES_AFTER);
		const prefix = model.getValueInRange(new monaco.Range(Math.max(1, position.lineNumber - LINES_BEFORE), 1, position.lineNumber, position.column));
		const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine)));
		const id = ++this.#seq;
		const cancel = token.onCancellationRequested(() => void invoke('local_ai_cancel', { id }).catch(() => {}));
		this.#inFlight++;
		this.state = 'loading';
		let text: string | null = null;
		let failed = '';
		try {
			text = await invoke<string | null>('local_ai_complete', { request: completionRequest(get, id, prefix, suffix) });
		} catch (e) {
			failed = String(e);
		} finally {
			cancel.dispose();
			this.#inFlight--;
		}
		// The newest request decides what the item says.
		if (id === this.#seq || !this.#inFlight) {
			if (failed && failed !== this.error) clientLog('info', `local AI completion: ${failed}`);
			this.error = failed;
			this.state = !this.completionsOn ? 'off' : this.#inFlight ? 'loading' : failed ? 'error' : 'idle';
		}
		if (!text || token.isCancellationRequested) return none;
		return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
	}

	toggleCompletions() {
		void settings.set('kingu.completions.enabled', this.completionsOn ? undefined : true, 'user');
	}

	/** Brings the open folder's index up to date in the background. */
	index() {
		if (!this.semanticOn || !workspace.root) return;
		invoke<SemanticStatus>('semantic_index', { config: semanticConfigFrom(get) })
			.then((s) => (this.semantic = s))
			.catch((e) => {
				this.semantic = { state: 'error', done: 0, total: 0, files: 0, chunks: 0, limited: false, error: String(e) };
				clientLog('info', `semantic index: ${e}`);
			});
	}

	async rebuild() {
		if (!this.semanticOn) return notifications.info(t('localAi.semantic.off'));
		await invoke('semantic_clear').catch(() => {});
		status.flash(t('localAi.semantic.rebuilding'));
		this.index();
	}

	/** Semantic Search: a query, then the closest chunks; Enter opens one at its line. */
	async search() {
		if (!this.semanticOn) return notifications.info(t('localAi.semantic.off'));
		if (!workspace.root) return notifications.info(t('localAi.semantic.noFolder'));
		const query = await quick.input({
			placeholder: t('localAi.semantic.placeholder'),
			hint: (value) => (value.trim() ? t('localAi.semantic.hint', { query: value.trim() }) : t('localAi.semantic.hintEmpty'))
		});
		if (!query) return;
		status.flash(t('localAi.semantic.searching'));
		let result: SemanticResult;
		try {
			result = await invoke<SemanticResult>('semantic_search', { config: semanticConfigFrom(get), query, limit: null });
		} catch (e) {
			notifications.error(t('localAi.semantic.failed', { error: String(e) }));
			return;
		}
		status.flash('', 0);
		this.semantic = result.status;
		const count = result.hits.length;
		const building = result.status.state === 'building';
		if (!count) return notifications.info(t('localAi.semantic.noResults', { query }));
		const items: PickItem[] = result.hits.map((hit, i) => ({ id: String(i), icon: hit.path, ...hitRow(hit) }));
		const placeholder = building
			? t('localAi.semantic.resultsIndexing', { count, query, done: result.status.done, total: result.status.total })
			: t('localAi.semantic.results', { count, query });
		const picked = await quick.choose({ placeholder, items });
		const hit = picked && result.hits[Number(picked.id)];
		if (hit) editors.openAt(hit.path, hit.line);
	}

	/** The status item's menu. */
	async menu() {
		const items: PickItem[] = [
			{ id: 'toggle', label: this.completionsOn ? t('localAi.menu.disable') : t('localAi.menu.enable') },
			this.semanticOn ? { id: 'search', label: t('localAi.menu.search') } : { id: 'semantic', label: t('localAi.menu.enableSemantic') },
			...(this.semanticOn ? [{ id: 'rebuild', label: t('localAi.menu.rebuild') }] : []),
			{ id: 'settings', label: t('localAi.menu.settings') }
		];
		const picked = await quick.choose({ placeholder: t('localAi.menu.placeholder'), items });
		if (picked?.id === 'toggle') this.toggleCompletions();
		else if (picked?.id === 'search') void this.search();
		else if (picked?.id === 'semantic') void settings.set('kingu.semanticSearch.enabled', true, 'user');
		else if (picked?.id === 'rebuild') void this.rebuild();
		else if (picked?.id === 'settings') systemSettings.show('Local AI');
	}
}

export const localAi = new LocalAi();

export function installLocalAi(): () => void {
	let provider: Monaco.IDisposable | null = null;
	let disposed = false;
	const register = async () => {
		const { monaco } = await import('#lib/editor/monaco.ts');
		if (disposed || provider || !localAi.completionsOn) return;
		provider = monaco.languages.registerInlineCompletionsProvider('*', {
			provideInlineCompletions: (model, position, _context, token) => localAi.provide(monaco, model, position, token),
			disposeInlineCompletions: () => {}
		});
	};
	const unregisterProvider = () => {
		provider?.dispose();
		provider = null;
	};

	const stopEvents = listen<SemanticStatus>('local-ai://semantic', (e) => {
		const before = localAi.semantic;
		localAi.semantic = e.payload;
		if (e.payload.state === 'ready' && before?.state === 'building' && before.total > 0) status.flash(t('localAi.semantic.ready', { files: e.payload.files }));
		if (e.payload.limited && !before?.limited) notifications.info(t('localAi.semantic.limited'));
	});

	let semanticWasOn = false;
	const stopEffects = $effect.root(() => {
		$effect(() => {
			if (!settings.loaded) return;
			const on = localAi.completionsOn;
			untrack(() => {
				localAi.state = on ? 'idle' : 'off';
				localAi.error = '';
				if (on) void register();
				else unregisterProvider();
			});
		});
		// The index follows the open folder and the semantic settings; turning it off deletes it.
		$effect(() => {
			if (!settings.loaded) return;
			const on = localAi.semanticOn;
			const config = JSON.stringify(semanticConfigFrom(get));
			const root = workspace.root;
			untrack(() => {
				if (on && root && config) localAi.index();
				else if (!on && semanticWasOn) {
					void invoke('semantic_clear').catch(() => {});
					localAi.semantic = null;
				}
				semanticWasOn = on;
			});
		});
	});

	const unregister = [
		commands.register({ id: 'kingu.completions.toggle', title: 'Toggle Inline Completions', category: 'Local AI', run: () => localAi.toggleCompletions() }),
		commands.register({ id: 'kingu.semanticSearch.search', title: 'Semantic Search', category: 'Local AI', run: () => localAi.search() }),
		commands.register({ id: 'kingu.semanticSearch.rebuild', title: 'Rebuild Semantic Index', category: 'Local AI', run: () => localAi.rebuild() }),
		commands.register({ id: 'kingu.localAi.menu', title: 'Show Local AI Menu', category: 'Local AI', run: () => localAi.menu() })
	];

	return () => {
		disposed = true;
		unregister.forEach((u) => u());
		stopEffects();
		void stopEvents.then((stop) => stop());
		unregisterProvider();
	};
}
