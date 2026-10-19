// Git blame in the editor (VS Code's extensions/git/src/blame.ts): the current line's commit after
// its text (`git.blame.editorDecoration.enabled`, `…template`), the same in the status bar
// (`git.blame.statusBarItem.enabled`, `…template`), and a hover with the commit's details
// (`git.blame.editorDecoration.disableHover`). One `git blame --porcelain` per file and HEAD /
// save / status, cached; the lines of an unsaved buffer are mapped onto the saved file's blame.

import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { locale, t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { getEntry } from '#lib/workbench/editorModels.ts';
import { scm } from '#lib/workbench/scm.svelte.ts';
import { historyDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { blameBuffer, formatTemplate, parseBlamePorcelain, templateTokens, type Blame, type BlameCommit, type LineBlame } from './blame';
import { activeView, isRepoFile, versions, type ScmView } from './scmViews.svelte';

export type CommitInfo = { hash: string; author: string; email: string; time: number; message: string; files: number; insertions: number; deletions: number };

type FileBlame = { key: string; blame: Blame | null; saved: string };

const OPEN_COMMIT = 'kingu.blame.openCommitChanges';
const COPY_HASH = 'kingu.blame.copyCommitHash';

class GitBlame {
	#files = $state<Record<string, FileBlame>>({});
	#pending = new Map<string, string>();
	/** Commit details for the hover, by hash. */
	commits = $state<Record<string, CommitInfo>>({});
	#commitPending = new Set<string>();
	/** The status bar item's text and its commit (the active editor's cursor line). */
	statusText = $state('');
	statusTitle = $state('');
	statusCommit = $state<{ hash: string; path: string } | null>(null);
	#buffers = new Map<string, { version: number; key: string; lines: LineBlame[] }>();

	get decorationEnabled() {
		return settings.get<boolean>('git.blame.editorDecoration.enabled');
	}
	get statusEnabled() {
		return settings.get<boolean>('git.blame.statusBarItem.enabled');
	}

	/** When the blame of `path` must be read again: HEAD, the file's status, a save, the whitespace setting. */
	#key(path: string): string {
		const e = versions.entry(path);
		return [scm.repo?.head ?? '', e?.index ?? '', e?.worktree ?? '', getEntry(path)?.savedVersion ?? '', settings.get<boolean>('git.blame.ignoreWhitespace')].join('|');
	}

	/** The blame of `path` (reactive); schedules a read when it is missing or stale. */
	file(path: string, model: Monaco.editor.ITextModel): FileBlame | null {
		if (!scm.repo || !isRepoFile(path)) return null;
		const key = this.#key(path);
		const have = this.#files[path];
		if (have?.key !== key && this.#pending.get(path) !== key) {
			this.#pending.set(path, key);
			queueMicrotask(() => void this.#load(path, key, model));
		}
		return have ?? null;
	}

	async #load(path: string, key: string, model: Monaco.editor.ITextModel) {
		let blame: Blame | null = null;
		let saved = '';
		try {
			const dirty = editors.isDirty(path);
			const [porcelain, disk] = await Promise.all([
				invoke<string>('scm_blame', { rel: path, ignoreWhitespace: settings.get<boolean>('git.blame.ignoreWhitespace') }),
				dirty || model.isDisposed() ? invoke<string>('read_workspace_file', { rel: path }) : Promise.resolve(model.getValue())
			]);
			blame = parseBlamePorcelain(porcelain);
			saved = disk;
		} catch (e) {
			// Untracked or ignored files have no blame.
			clientLog('info', `blame ${path}: ${e}`);
		} finally {
			if (this.#pending.get(path) === key) this.#pending.delete(path);
		}
		this.#files[path] = { key, blame, saved };
	}

	/** The blame of buffer line `line` of `path`. */
	line(path: string, model: Monaco.editor.ITextModel, line: number): LineBlame | null {
		const f = this.file(path, model);
		if (!f?.blame) return null;
		const version = model.getAlternativeVersionId();
		let b = this.#buffers.get(path);
		if (!b || b.version !== version || b.key !== f.key) {
			b = { version, key: f.key, lines: blameBuffer(f.blame, f.saved, model.getValue()) };
			this.#buffers.set(path, b);
		}
		return b.lines[line - 1] ?? null;
	}

	/** Loads the hover's details of `hash` once. */
	commit(hash: string): CommitInfo | undefined {
		const have = this.commits[hash];
		if (!have && !this.#commitPending.has(hash)) {
			this.#commitPending.add(hash);
			void invoke<CommitInfo>('scm_commit_info', { hash })
				.then((c) => (this.commits[hash] = c))
				.catch((e) => clientLog('info', `commit ${hash}: ${e}`))
				.finally(() => this.#commitPending.delete(hash));
		}
		return have;
	}

	text(template: string, c: BlameCommit): string {
		return formatTemplate(template, templateTokens(c, { nowMs: Date.now(), locale: locale(), shortLength: settings.get<number>('git.commitShortHashLength') }));
	}

	/** VS Code's blame hover: author, date, message, stats and the commit's actions. */
	hover(c: BlameCommit, path: string): string {
		const info = this.commit(c.hash);
		const tokens = templateTokens(c, { nowMs: Date.now(), locale: locale(), shortLength: settings.get<number>('git.commitShortHashLength') });
		const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
		const arg = (v: unknown) => encodeURIComponent(JSON.stringify([v]));
		const lines = [`**${esc(c.authorName)}** ${c.authorEmail ? `<${esc(c.authorEmail)}>` : ''}, ${esc(tokens.authorDateAgo)} (${esc(tokens.authorDate)})`, '', esc(info?.message ?? c.subject).replace(/\n/g, '  \n')];
		if (info) lines.push('', t('scmEditor.blame.stats', { files: info.files, insertions: info.insertions, deletions: info.deletions }));
		lines.push(
			'',
			'---',
			'',
			`\`${tokens.hashShort}\` · [${t('scmEditor.blame.openChanges')}](command:${OPEN_COMMIT}?${arg({ hash: c.hash, path })}) · [${t('scmEditor.blame.copyHash')}](command:${COPY_HASH}?${arg(c.hash)})`
		);
		return lines.join('\n');
	}
}

export const gitBlame = new GitBlame();

export type BlameHandle = { render(): void; dispose(): void };

/** The current lines' blame after their text in `view` (and the status bar item when it is the active editor). */
export function attachBlame(view: ScmView): BlameHandle {
	const { ed, monaco } = view;
	const decorations = ed.createDecorationsCollection();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function draw() {
		const path = view.path();
		const model = ed.getModel();
		const deco = gitBlame.decorationEnabled;
		const bar = gitBlame.statusEnabled;
		const active = activeView() === view;
		if (!model || !path || !isRepoFile(path) || (!deco && !(bar && active))) {
			decorations.clear();
			if (active) gitBlame.statusText = '';
			return;
		}
		const lines = [...new Set((ed.getSelections() ?? []).map((s) => s.positionLineNumber))];
		const template = settings.get<string>('git.blame.editorDecoration.template');
		const hoverOn = !settings.get<boolean>('git.blame.editorDecoration.disableHover');
		const items: Monaco.editor.IModelDeltaDecoration[] = [];
		for (const line of deco ? lines : []) {
			const b = gitBlame.line(path, model, line);
			if (!b) continue;
			const text = b.kind === 'commit' ? gitBlame.text(template, b.commit) : t('scmEditor.blame.notCommitted');
			const end = model.getLineMaxColumn(line);
			items.push({
				range: new monaco.Range(line, end, line, end),
				options: {
					after: { content: `   ${text}`, inlineClassName: 'kg-blame-after', cursorStops: monaco.editor.InjectedTextCursorStops.None },
					hoverMessage: hoverOn && b.kind === 'commit' ? { value: gitBlame.hover(b.commit, path), isTrusted: true, supportThemeIcons: true } : undefined
				}
			});
		}
		decorations.set(items);
		if (active) {
			const line = ed.getPosition()?.lineNumber ?? 1;
			const b = bar ? gitBlame.line(path, model, line) : null;
			gitBlame.statusText = !b ? '' : b.kind === 'commit' ? gitBlame.text(settings.get<string>('git.blame.statusBarItem.template'), b.commit) : t('scmEditor.blame.notCommitted');
			gitBlame.statusTitle = b?.kind === 'commit' ? `${b.commit.subject}\n${b.commit.authorName}, ${new Date(b.commit.authorTime * 1000).toLocaleString(locale())}` : '';
			gitBlame.statusCommit = b?.kind === 'commit' ? { hash: b.commit.hash, path } : null;
		}
	}

	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(draw, 120);
	};
	const subs = [ed.onDidChangeCursorSelection(later), ed.onDidChangeModelContent(later), ed.onDidFocusEditorText(draw), ed.onDidChangeModel(draw)];

	return {
		render() {
			// Reactive: the settings, the file's blame and the commit details re-run the caller's effect.
			for (const id of ['git.blame.editorDecoration.enabled', 'git.blame.editorDecoration.template', 'git.blame.editorDecoration.disableHover', 'git.blame.statusBarItem.enabled', 'git.blame.statusBarItem.template', 'git.blame.ignoreWhitespace'])
				void settings.get(id);
			void editors.active;
			const path = view.path();
			const model = ed.getModel();
			if (path && model && (gitBlame.decorationEnabled || gitBlame.statusEnabled)) void gitBlame.file(path, model);
			draw();
		},
		dispose() {
			clearTimeout(timer);
			subs.forEach((s) => s.dispose());
			decorations.clear();
			if (activeView() === view || !activeView()) gitBlame.statusText = '';
		}
	};
}

export function openCommitChanges(hash: string, path: string) {
	editors.open(historyDiffKey(hash, path), { preview: true });
}

let monacoCommands = false;
export function installBlameMonacoCommands(monaco: typeof Monaco) {
	if (monacoCommands) return;
	monacoCommands = true;
	monaco.editor.registerCommand(OPEN_COMMIT, (_a, arg: { hash: string; path: string }) => arg && openCommitChanges(arg.hash, arg.path));
	monaco.editor.registerCommand(COPY_HASH, (_a, hash: string) => {
		void navigator.clipboard.writeText(hash).then(() => status.flash(t('scmEditor.copied')));
	});
}

export function installBlameCommands(): () => void {
	const toggle = (id: string) => () => settings.set(id, !settings.get<boolean>(id), 'user');
	const off = [
		commands.register({ id: 'git.blame.toggleEditorDecoration', title: 'Git: Toggle Git Blame Editor Decoration', run: toggle('git.blame.editorDecoration.enabled') }),
		commands.register({ id: 'git.blame.toggleStatusBarItem', title: 'Git: Toggle Git Blame Status Bar Item', run: toggle('git.blame.statusBarItem.enabled') })
	];
	return () => off.forEach((u) => u());
}
