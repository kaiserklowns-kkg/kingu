// The Source Control More Actions (…) menu's model (VS Code's git extension scm/title submenus),
// pure so bun tests check it names only registered command ids and keeps VS Code's grouping.

import type { MenuNode } from '#lib/workbench/menus.ts';

export type SubmenuKey = 'scmGit.menuCommit' | 'scmGit.menuChanges' | 'scmGit.menuPullPush' | 'scmGit.menuBranch' | 'scmGit.menuRemote' | 'scmGit.menuStash' | 'scmGit.menuTags' | 'scmGit.menuWorktrees';

/** `[i18n key of the submenu, command ids (null: a separator)]`. */
export const SCM_MENU: readonly [SubmenuKey, readonly (string | null)[]][] = [
	['scmGit.menuCommit', ['git.commit', 'git.commitAmend', 'git.commitNoVerify', 'git.commitEmpty', null, 'git.undoCommit']],
	['scmGit.menuChanges', ['git.stageAll', 'git.unstageAll']],
	['scmGit.menuPullPush', ['git.sync', null, 'git.pull', 'git.pullRebase', null, 'git.push', 'git.pushForce', null, 'git.fetch']],
	['scmGit.menuBranch', ['git.merge', 'git.rebase', null, 'git.branch', 'git.branchFrom', 'git.checkoutDetached', null, 'git.deleteBranch', null, 'git.publish']],
	['scmGit.menuRemote', ['git.addRemote', 'git.removeRemote', 'git.renameRemote']],
	['scmGit.menuStash', ['git.stash', 'git.stashIncludeUntracked', null, 'git.stashApplyLatest', 'git.stashApply', 'git.stashPopLatest', 'git.stashPop', null, 'git.stashDrop', 'git.stashDropAll', null, 'git.viewStash']],
	['scmGit.menuTags', ['git.createTag', 'git.deleteTag', null, 'git.pushTags']],
	['scmGit.menuWorktrees', ['git.createWorktree', null, 'git.openWorktree', 'git.openWorktreeInNewWindow', null, 'git.deleteWorktree']]
];

/** The top-level commands above the submenus. */
export const SCM_MENU_TOP: readonly string[] = ['git.pull', 'git.push', 'git.clone', 'git.checkout', 'git.fetch'];

export function scmMenu(ctx: { enabled: (id: string) => boolean; label: (id: string) => string; submenu: (key: SubmenuKey) => string }): MenuNode[] {
	const item = (id: string): MenuNode => ({ type: 'item', id, text: ctx.label(id), enabled: ctx.enabled(id) });
	const top = SCM_MENU_TOP.map(item);
	const subs = SCM_MENU.map(([key, ids]): MenuNode => ({
		type: 'submenu',
		id: key,
		text: ctx.submenu(key),
		items: ids.map((id) => (id === null ? { type: 'separator' } : item(id)))
	}));
	return [...top, { type: 'separator' }, ...subs];
}
