<script lang="ts">
	// The Source Control view's More Actions (…) menu (VS Code's scm/title submenus of the git
	// extension): Commit, Changes, Pull/Push, Branch, Remote, Stash, Tags and Worktrees. Every item is
	// a command id (commands.run), greyed out when the command's `when` does not hold.
	import { t } from '#lib/i18n/index.ts';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { scmMenu } from './scmMenu';

	let at = $state<{ x: number; y: number } | null>(null);

	const items = $derived.by((): MenuNode[] => {
		void at;
		const enabled = (id: string) => commands.enabled(id);
		const label = (id: string) => commands.get(id)?.title.replace(/^Git: /, '') ?? id;
		return scmMenu({ enabled, label, submenu: (key) => t(key) });
	});
</script>

<button
	class="kg-view-actions grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
	aria-label={t('scmGit.moreActions')}
	title={t('scmGit.moreActions')}
	aria-haspopup="menu"
	onclick={(e) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		at = { x: r.left, y: r.bottom + 2 };
	}}><Icon name="more" size={16} /></button
>

{#if at}
	<PopupMenu
		{items}
		label={t('scmGit.moreActions')}
		x={at.x}
		y={at.y}
		focusFirst
		onRun={(node) => {
			if (node.type === 'item') void commands.run(node.id);
		}}
		onClose={() => (at = null)}
	/>
{/if}
