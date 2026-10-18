// Actions of a worktree card in the Agents side bar (Orca's worktree context menu) and the rows
// of the Worktree Jump palette. Pure: the menu is data; Svelte code runs the chosen id.

import type { TaskStatus } from './model';

export type WorktreeAction =
	| 'open'
	| 'openInEditor'
	| 'newTerminal'
	| 'quickOpen'
	| 'reveal'
	| 'copyBranch'
	| 'rename'
	| 'copyPath'
	| 'rename'
	| 'markDone'
	| 'reopen'
	| 'remove'
	| `openIn:${string}`;

export type ActionRow = { id: WorktreeAction; label: string; enabled?: boolean } | 'separator';

/** At most this many `kingu.worktree.openIn` apps (Orca's Open In rows). */
export const MAX_OPEN_IN = 8;

/** The `kingu.worktree.openIn` labels with a non-empty command, in order, at most MAX_OPEN_IN. */
export function openInLabels(setting: Readonly<Record<string, unknown>> | undefined): string[] {
	return Object.entries(setting ?? {})
		.filter(([label, cmd]) => label.trim() && typeof cmd === 'string' && cmd.trim())
		.map(([label]) => label)
		.slice(0, MAX_OPEN_IN);
}

/** The folder itself (`slug` null) or a task worktree; `running`: its agent is mid-turn. `openIn`: Open In app labels. */
export function worktreeActions(w: { slug: string | null; status?: TaskStatus; running?: boolean; hasWorktree?: boolean; openIn?: readonly string[] }): ActionRow[] {
	const task = w.slug !== null;
	const rows: ActionRow[] = [
		{ id: 'open', label: 'เปิด (Open)' },
		{ id: 'openInEditor', label: 'เปิดใน Editor (Open in Editor)' },
		{ id: 'newTerminal', label: 'Terminal ใหม่ใน worktree นี้' },
		{ id: 'quickOpen', label: 'เปิดไฟล์… (Go to File)', enabled: !task || w.hasWorktree !== false },
		'separator',
		{ id: 'reveal', label: 'แสดงใน Finder (Reveal in Finder)', enabled: !task || w.hasWorktree !== false },
		...(w.openIn ?? []).map((label): ActionRow => ({ id: `openIn:${label}`, label: `เปิดใน ${label} (Open in ${label})`, enabled: !task || w.hasWorktree !== false })),
		{ id: 'copyPath', label: 'คัดลอก path' }
	];
	if (!task) return rows;
	rows.push({ id: 'copyBranch', label: 'คัดลอกชื่อ branch' }, { id: 'rename', label: 'เปลี่ยนชื่อ… (Rename)' }, 'separator');
	rows.push(w.status === 'done' ? { id: 'reopen', label: 'เปิดงานอีกครั้ง' } : { id: 'markDone', label: 'ปิดงาน (Mark as Done)', enabled: !w.running });
	rows.push({ id: 'remove', label: 'ลบงานและ worktree…', enabled: !w.running });
	return rows;
}

export type JumpRow = { key: string; label: string; description: string; group: string };

/** Worktree Jump palette rows: the folder first, then tasks needing you, in progress, done. */
export function jumpRows(
	folder: { name: string; branch: string },
	groups: { label: string; tasks: { slug: string; title: string; status: string; branch?: string }[] }[]
): JumpRow[] {
	const rows: JumpRow[] = [{ key: '', label: folder.name, description: `primary · ${folder.branch || 'HEAD'}`, group: 'โฟลเดอร์' }];
	for (const g of groups) for (const t of g.tasks) rows.push({ key: t.slug, label: t.title, description: `${t.status} · ${t.branch ?? `kingu/${t.slug}`}`, group: g.label });
	return rows;
}
