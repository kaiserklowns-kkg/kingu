// Add Context's sources (VS Code's "Add Context..." quick pick, ⌥⌘P in the chat; `#` and `@` list
// them inline too, with the folder's files): each resolves to what the panel attaches — a file
// chip, a `ContextText` (inlined by assemblePrompt) or an image. chatContext.ts has the pure part.
//
//   contextFiles.refresh()        the folder's files and folders, files.exclude and search.exclude
//                                 applied like Quick Open
//   mentionItems(query, …)        the `#` / `@` list: matching sources, then folders and files
//   resolveMention(item, env)     what a picked row attaches
//   pickContext(env)              the modal Add Context picker (sources, then that source's list)

import { invoke } from '@tauri-apps/api/core';
import type { IconName } from '#lib/workbench/Icon.svelte';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { recentFiles } from '#lib/workbench/recentFiles.svelte.ts';
import { rankFiles } from '#lib/workbench/quickAccess.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { enabledGlobs, hiddenBySibling, isExcluded, siblingClauses } from '#lib/settings/mappings.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { lastTerminal, terminalHandle, type TerminalHandle } from '#lib/terminal/registry.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import type { SuggestItem } from './SlashSuggest.svelte';
import { savePastedImage } from './attachInput.ts';
import { pickMcpResource } from './mcpChat.svelte.ts';
import { chats } from './chats.svelte.ts';
import { isFileKey, type ContextText } from './chatPrompt.ts';
import { CONTEXT_SOURCES, DRILL_SOURCES, filterScoped, folderContext, foldersOf, isInstructionsFile, lastCommandOutput, MENTION_FILES, pastChatContext, planMentions, problemsContext, type ContextSource, type MentionScope } from './chatContext.ts';
import type { AgentEvent } from './events';

/** What a source attaches. */
export type ContextPick = { kind: 'file'; path: string; range?: { startLine: number; endLine: number } } | { kind: 'text'; text: ContextText } | { kind: 'image'; path: string };

/** Where the chat runs and which chat it is (Past Chat leaves it out). */
export type ContextEnv = { cwd: string | null; chatId: string | null };

export const SOURCE_ICON: Record<ContextSource, IconName> = {
	files: 'file',
	selection: 'crosshair',
	problems: 'warning',
	scm: 'git',
	terminal: 'terminal',
	clipboardImage: 'image',
	pastChat: 'agent',
	instructions: 'listChecks',
	mcpResources: 'ports'
};

export const sourceLabel = (s: ContextSource): string => t(`chatContext.source.${s}`);
const sourceHint = (s: ContextSource): string => t(`chatContext.sourceHint.${s}`);

class ContextFiles {
	/** Workspace-relative files, excluded ones left out. */
	list = $state<string[]>([]);
	folders = $derived(foldersOf(this.list));
	#at = 0;
	#root: string | null = null;

	/** Lists the folder again, at most once every few seconds. */
	async refresh(root: string | null, force = false) {
		if (!root) return void (this.list = []);
		if (!force && root === this.#root && Date.now() - this.#at < 5000) return;
		this.#root = root;
		this.#at = Date.now();
		const all = await invoke<string[]>('fs_list_files').catch(() => [] as string[]);
		// files.exclude and search.exclude, like Quick Open (QuickInput.svelte).
		const exclude = [...enabledGlobs(settings.get('files.exclude')), ...enabledGlobs(settings.get('search.exclude'))];
		const clauses = siblingClauses(settings.get('files.exclude'), settings.get('search.exclude'));
		const known = new Set(all);
		if (this.#root === root) this.list = all.filter((f) => !isExcluded(f, exclude) && !hiddenBySibling(f, clauses, (p) => known.has(p)));
	}
}

export const contextFiles = new ContextFiles();

const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');
const fileRow = (path: string): SuggestItem => ({ key: `file:${path}`, name: path.split('/').pop() || path, description: dirOf(path), icon: 'file' });
const folderRow = (path: string): SuggestItem => ({ key: `folder:${path}`, name: `${path.split('/').pop() || path}/`, description: dirOf(path), icon: 'folder' });

/** The `@` menu's names for the sources (Cursor's wording where it has one). */
export const mentionLabel = (s: ContextSource): string => t(`composer.mention.source.${s}`);

/**
 * The `#` / `@` list (Cursor's `@` menu, chatContext.ts `planMentions`): the current file (and
 * recent ones), a separator, then the sources while nothing is typed; else matching sources,
 * folders and files. Files & Folders, Terminals and Past Chats open in the list itself (`scope`).
 * `attached`: files already in the input, left out of the first rows.
 */
export function mentionItems(query: string, scope: MentionScope | null = null, attached: readonly string[] = [], env: ContextEnv = { cwd: null, chatId: null }): SuggestItem[] {
	if (scope === 'terminals') {
		const rows = terminals.list.map((x) => ({ key: `terminal:${terminals.key(x.id)}`, name: x.title, label: x.title, description: '', icon: 'terminal' as const }));
		return filterScoped(rows, query);
	}
	if (scope === 'chats') {
		const rows = chats.sorted.filter((c) => c.id !== env.chatId).map((c) => ({ key: `chat:${c.id}`, name: c.title, label: c.title, description: timeLabel(c.updated_at || c.created_at), icon: 'chat' as const }));
		return filterScoped(rows, query);
	}
	const ranked = rankFiles(query, contextFiles.list, recentFiles.list, MENTION_FILES).map((r) => r.path);
	const active = isFileKey(editors.active) ? editors.active : null;
	const plan = planMentions({
		query,
		scope,
		active,
		recent: recentFiles.list,
		ranked: scope === 'files' && !query && !ranked.length ? contextFiles.list.slice(0, MENTION_FILES) : ranked,
		folders: contextFiles.folders,
		attached,
		label: mentionLabel
	});
	const sources: SuggestItem[] = plan.sources.map((s, i) => ({
		key: `source:${s}`,
		name: mentionLabel(s),
		description: '',
		icon: SOURCE_ICON[s],
		...(DRILL_SOURCES[s] ? { drill: DRILL_SOURCES[s] } : {}),
		...(i === 0 && plan.current.length ? { section: '' } : {})
	}));
	const rows = [...plan.folders.map(folderRow), ...plan.files.map(fileRow)];
	if (rows.length && sources.length) rows[0] = { ...rows[0], section: '' };
	const current = plan.current.map((p) => ({ ...fileRow(p), ...(p === active ? { tag: t('chatView.currentFile') } : {}) }));
	return [...current, ...sources, ...rows];
}

const timeLabel = (at: string | number) => {
	const d = new Date(at);
	return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

/** What a picked `#` / `@` row attaches. */
export async function resolveMention(item: SuggestItem, env: ContextEnv): Promise<ContextPick[]> {
	const key = item.key ?? '';
	if (key.startsWith('file:')) return [{ kind: 'file', path: key.slice(5) }];
	if (key.startsWith('folder:')) return [{ kind: 'text', text: folderContext(key.slice(7), contextFiles.list) }];
	if (key.startsWith('source:')) return resolveSource(key.slice(7) as ContextSource, env);
	if (key.startsWith('terminal:')) return terminalContext(terminalHandle(key.slice(9)));
	if (key.startsWith('chat:')) return pastChat(key.slice(5), item.name);
	return [];
}

/** Add Context: pick a source, then (for the ones that list things) what from it. */
/** Add Context's list; `extra` rows (the chat panel's Files from Disk...) go first and run their own `run`. */
export async function pickContext(env: ContextEnv, extra: { id: string; label: string; description: string; run: () => void }[] = []): Promise<ContextPick[]> {
	const item = await quick.choose({
		placeholder: t('chatContext.pick'),
		items: [...extra.map((x) => ({ id: `extra:${x.id}`, label: x.label, description: x.description })), ...CONTEXT_SOURCES.map((s) => ({ id: s, label: sourceLabel(s), description: sourceHint(s) }))]
	});
	const own = item && extra.find((x) => `extra:${x.id}` === item.id);
	if (own) return (own.run(), []);
	return item ? resolveSource(item.id as ContextSource, env) : [];
}

/** One source's context; empty (with a status message) when it has nothing to give. */
export async function resolveSource(source: ContextSource, env: ContextEnv): Promise<ContextPick[]> {
	const none = (key: `chatContext.none.${Exclude<ContextSource, 'files'>}`): ContextPick[] => (status.flash(t(key), 5000), []);
	switch (source) {
		case 'files':
			return pickFileOrFolder();
		case 'selection': {
			const path = isFileKey(editors.active) ? editors.active : null;
			const range = editors.selection.range;
			return path && range ? [{ kind: 'file', path, range }] : none('chatContext.none.selection');
		}
		case 'problems': {
			const p = problemsContext(lsp.problems);
			return p ? [{ kind: 'text', text: { ...p, label: t('chatContext.label.problems', { count: p.label }) } }] : none('chatContext.none.problems');
		}
		case 'scm': {
			if (!env.cwd) return [];
			const diff = await invoke<string>('chat_context_git_diff', { cwd: env.cwd }).catch((e) => (status.flash(String(e), 8000), null));
			if (diff === null) return [];
			return diff.trim() ? [{ kind: 'text', text: { kind: 'git-diff', label: t('chatContext.label.scm'), text: diff } }] : none('chatContext.none.scm');
		}
		case 'terminal':
			return terminalContext(lastTerminal() ?? terminalHandle(terminals.key(terminals.active)));
		case 'clipboardImage':
			return clipboardImage();
		case 'pastChat':
			return pickPastChat(env.chatId);
		case 'instructions':
			return pickInstructions(env.cwd);
		case 'mcpResources':
			return pickMcpResource(env);
	}
}

/** A terminal's last command and its output. */
function terminalContext(h: TerminalHandle | null): ContextPick[] {
	const out = h?.lines ? lastCommandOutput(h.lines()) : null;
	if (!out || !out.output.trim()) return (status.flash(t('chatContext.none.terminal'), 5000), []);
	const text = out.command ? `$ ${out.command}\n${out.output}` : out.output;
	return [{ kind: 'text', text: { kind: 'terminal', label: out.command ? t('chatContext.label.terminalCommand', { command: out.command }) : t('chatContext.label.terminal'), text } }];
}

/** What was asked and answered in chat `id`. */
async function pastChat(id: string, title: string): Promise<ContextPick[]> {
	const events = await invoke<AgentEvent[]>('chat_transcript_load', { id }).catch(() => [] as AgentEvent[]);
	const ctx = pastChatContext(title, events);
	return ctx ? [{ kind: 'text', text: ctx }] : (status.flash(t('chatContext.none.pastChat'), 5000), []);
}

async function pickFileOrFolder(): Promise<ContextPick[]> {
	const item = await quick.choose({
		placeholder: t('chatContext.pickFile'),
		items: [],
		dynamic: (q) => {
			const files = rankFiles(q, contextFiles.list, recentFiles.list, 50).map((r) => r.path);
			const shown = files.length ? files : q ? [] : contextFiles.list.slice(0, 50);
			const lq = q.toLowerCase();
			const folders = q ? contextFiles.folders.filter((d) => d.toLowerCase().includes(lq)).slice(0, 10) : [];
			const rows: PickItem[] = [
				...folders.map((d, i) => ({ id: `folder:${d}`, label: `${d.split('/').pop() || d}/`, description: d, ...(i === 0 ? { separator: t('chatContext.tag.folder') } : {}) })),
				...shown.map((path, i) => ({ id: `file:${path}`, label: path.split('/').pop() || path, description: path, icon: path, ...(i === 0 && folders.length ? { separator: t('chatContext.tag.file') } : {}) }))
			];
			return rows;
		}
	});
	if (!item) return [];
	if (item.id.startsWith('folder:')) return [{ kind: 'text', text: folderContext(item.id.slice(7), contextFiles.list) }];
	return [{ kind: 'file', path: item.id.slice(5) }];
}

async function clipboardImage(): Promise<ContextPick[]> {
	try {
		for (const item of await navigator.clipboard.read()) {
			const type = item.types.find((x) => x.startsWith('image/'));
			if (type) return [{ kind: 'image', path: await savePastedImage(await item.getType(type)) }];
		}
	} catch (e) {
		status.flash(t('chatContext.clipboardFailed', { error: String(e) }), 8000);
		return [];
	}
	status.flash(t('chatContext.none.clipboardImage'), 5000);
	return [];
}

async function pickPastChat(current: string | null): Promise<ContextPick[]> {
	const others = chats.sorted.filter((c) => c.id !== current);
	if (!others.length) return (status.flash(t('chatContext.none.pastChat'), 5000), []);
	const item = await quick.choose({ placeholder: t('chatContext.pickChat'), items: others.map((c) => ({ id: c.id, label: c.title, description: timeLabel(c.updated_at || c.created_at) })) });
	return item ? pastChat(item.id, item.label) : [];
}

type Rule = { path: string; rel: string; description: string | null };

async function pickInstructions(cwd: string | null): Promise<ContextPick[]> {
	const rules = cwd ? await invoke<Rule[]>('chat_rules', { cwd, files: [] }).catch(() => [] as Rule[]) : [];
	const seen = new Set<string>();
	const items: PickItem[] = [];
	for (const path of contextFiles.list.filter(isInstructionsFile)) {
		seen.add(path);
		items.push({ id: path, label: path.split('/').pop() || path, description: path, icon: path });
	}
	for (const r of rules) {
		if (seen.has(r.rel)) continue;
		seen.add(r.rel);
		items.push({ id: r.path, label: r.rel.split('/').pop() || r.rel, description: [r.rel, r.description ?? ''].filter(Boolean).join(' · '), icon: r.rel });
	}
	if (!items.length) return (status.flash(t('chatContext.none.instructions'), 5000), []);
	const item = await quick.choose({ placeholder: t('chatContext.pickInstructions'), items });
	return item ? [{ kind: 'file', path: item.id }] : [];
}
