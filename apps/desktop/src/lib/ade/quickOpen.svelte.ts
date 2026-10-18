// ⌘P in the Agents layout (Orca's QuickOpen): the selected worktree's files, recent ones first,
// opened as a tab of that worktree. A visit is recorded whenever a file tab of a worktree is
// shown (Orca records editor visits, not only picks), per folder + worktree, in localStorage.

import { invoke } from '@tauri-apps/api/core';
import { enabledGlobs, isExcluded } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { persist, restore } from '#lib/terminal/sessions.ts';
import { adeLayout, PRIMARY } from './adeLayout.svelte.ts';
import { worktreeDir } from './keys.ts';
import { historyOf, historyScope, LISTING_CAP, parseHistory, parseTarget, rankWithHistory, recordVisit, relInWorktree, worktreeFile, type QuickOpenHistory } from './quickOpen.ts';

const STORE = 'kingu.quickOpenHistory.v1';

let history: QuickOpenHistory = restore(STORE, parseHistory) ?? [];

const dirOf = (key: string) => (key === PRIMARY ? '' : worktreeDir(key));

/** A file tab of worktree `key` was shown: it becomes that worktree's most recent file. */
export function recordQuickOpenVisit(key: string, file: string) {
	const root = workspace.root;
	const rel = relInWorktree(dirOf(key), file);
	if (!root || rel === null) return;
	const next = recordVisit(history, historyScope(root, key), rel);
	if (next === history) return;
	history = next;
	persist(STORE, history);
}

/** Opens the quick open of worktree `key` ('' = the folder itself). */
export async function quickOpenWorktree(key: string) {
	const root = workspace.root;
	if (!root) return status.flash('เปิดโฟลเดอร์ก่อน');
	let files: string[];
	try {
		files = key === PRIMARY ? await invoke<string[]>('fs_list_files') : await invoke<string[]>('worktree_list_files', { slug: key });
	} catch (e) {
		status.flash(String(e), 8000);
		return;
	}
	// files.exclude and search.exclude apply, like the IDE's quick open.
	const exclude = [...enabledGlobs(settings.get('files.exclude')), ...enabledGlobs(settings.get('search.exclude'))];
	files = files.filter((f) => !isExcluded(f, exclude));
	if (files.length >= LISTING_CAP) status.flash(`worktree มีไฟล์มากกว่า ${LISTING_CAP} ไฟล์ อาจไม่แสดงครบ พิมพ์ชื่อให้เจาะจงขึ้น`, 6000);
	const listed = new Set(files);
	const recent = historyOf(history, historyScope(root, key));
	const dir = dirOf(key);
	let at: { line?: number; column?: number } = {};
	quick.pick({
		placeholder: key === PRIMARY ? 'ไปที่ไฟล์… (path:บรรทัด เพื่อไปบรรทัด)' : `ไปที่ไฟล์ใน worktree ${key}… (path:บรรทัด เพื่อไปบรรทัด)`,
		items: [],
		dynamic: (value) => {
			const target = parseTarget(value, listed);
			at = { line: target.line, column: target.column };
			return rankWithHistory(target.query, files, recent).map((r) => {
				const slash = r.path.lastIndexOf('/');
				return {
					id: r.path,
					label: r.path.slice(slash + 1),
					description: slash > 0 ? r.path.slice(0, slash) : '',
					separator: r.recent ? 'ล่าสุด' : undefined,
					positions: r.positions.filter((p) => p > slash).map((p) => p - slash - 1),
					icon: r.path
				};
			});
		},
		onAccept: (item) => {
			// Orca opens an edit tab, not a preview.
			adeLayout.openFile(key, worktreeFile(dir, item.id), { preview: false, reveal: at.line ? { line: at.line, column: at.column ?? 1, focus: true } : undefined });
		}
	});
}
