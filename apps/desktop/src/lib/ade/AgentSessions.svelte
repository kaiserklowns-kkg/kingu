<script lang="ts">
	// Agents tab of the ADE's right side bar (Orca's "Agents" session history): every agent session
	// of the folder, newest first, with its worktree, CLI and state. A click jumps to its worktree;
	// the menu resumes it in the worktree's terminal, starts a fresh CLI there, or copies the resume
	// command or session id.
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { cliOf } from './agentCli.ts';
	import { profileOf } from './agentProfiles.ts';
	import { cliSessions } from './cliSessions.svelte.ts';
	import { STATUS_LABEL, timeAgo, type TaskView } from './model.ts';
	import { shellJoin, sortSessions, type SessionSort } from './rightSidebar.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { STATUS_DOT } from './ui.ts';

	let { current }: { current: string } = $props();
	let sort = $state<SessionSort>('updated');
	let menu = $state<{ x: number; y: number; view: TaskView } | null>(null);
	const sessions = $derived(sortSessions(adeTasks.views, sort));

	function resumeArgv(v: TaskView): string[] | null {
		const cli = cliOf(v.meta.agent);
		if (!cli) return null;
		const profile = profileOf(cli);
		if (!profile.canResume) return null;
		return profile.launch(cli, { resume: v.meta.session_id }, { servers: {}, plugins: [] }).argv;
	}

	async function copy(text: string, what: string) {
		try {
			await navigator.clipboard.writeText(text);
			status.flash(`คัดลอก${what}แล้ว`);
		} catch {
			status.flash(`คัดลอก${what}ไม่ได้`);
		}
	}

	function items(v: TaskView): MenuNode[] {
		const cli = cliOf(v.meta.agent);
		const live = cliSessions.has(v.meta.slug);
		const resumable = !!resumeArgv(v);
		return [
			menuItem('jump', 'ไปที่ worktree (Jump to Worktree)'),
			menuSeparator,
			menuItem('resume', 'ทำงานต่อใน session เดิม (Resume)', { enabled: !!cli && resumable && !live }),
			menuItem('fresh', `เริ่ม ${cli?.[0] ?? 'CLI'} ใหม่ใน worktree นี้`, { enabled: !!cli && !live }),
			menuSeparator,
			menuItem('copyResume', 'คัดลอกคำสั่ง resume', { enabled: resumable }),
			menuItem('copyId', 'คัดลอก session id', { enabled: !!v.meta.session_id })
		];
	}

	function run(v: TaskView, id: string) {
		const slug = v.meta.slug;
		if (id === 'jump') adeLayout.show(slug);
		else if (id === 'resume' || id === 'fresh') {
			appMode.setMode('agents');
			adeLayout.show(slug);
			adeLayout.select(slug, 'main');
			void adeTasks.resumeCli(slug, id === 'fresh');
		} else if (id === 'copyResume') {
			const argv = resumeArgv(v);
			if (argv) void copy(shellJoin(argv), 'คำสั่ง resume ');
		} else if (id === 'copyId' && v.meta.session_id) void copy(v.meta.session_id, ' session id ');
	}

	function openMenu(e: MouseEvent, v: TaskView) {
		e.preventDefault();
		e.stopPropagation();
		menu = { x: e.clientX, y: e.clientY, view: v };
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-8 shrink-0 items-center gap-1 pr-2 pl-3">
		<span class="min-w-0 flex-1 truncate text-[13px] font-medium">Agents</span>
		<label class="flex items-center gap-1 text-xs text-(--vscode-descriptionForeground)">
			<span class="sr-only">เรียงตาม</span>
			<select class="bg-transparent outline-none" bind:value={sort}>
				<option value="updated">อัปเดตล่าสุด</option>
				<option value="created">สร้างล่าสุด</option>
			</select>
		</label>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 text-[13px]" role="list" aria-label="Agent sessions">
		{#each sessions as v (v.meta.slug)}
			{@const live = cliSessions.has(v.meta.slug) || !!v.runtime?.live}
			<div
				role="listitem"
				class={['group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-(--vscode-list-hoverBackground)', v.meta.slug === current && 'bg-(--vscode-list-inactiveSelectionBackground)']}
				oncontextmenu={(e) => openMenu(e, v)}
			>
				<span class={['mt-1.5 size-2 shrink-0 rounded-full', STATUS_DOT[v.status]]} title={STATUS_LABEL[v.status]}></span>
				<button class="min-w-0 flex-1 text-left" title="ไปที่ worktree kingu/{v.meta.slug}" onclick={() => adeLayout.show(v.meta.slug)}>
					<span class="block truncate">{v.meta.title}</span>
					<span class="flex gap-1.5 text-xs text-(--vscode-descriptionForeground)">
						<span class="truncate">{v.meta.agent}{live ? ' · กำลังรัน' : ''}</span>
						<span class="shrink-0">· {timeAgo(sort === 'created' ? v.meta.created_at : v.meta.updated_at, adeTasks.now)}</span>
					</span>
					<span class="block truncate font-mono text-[11px] text-(--vscode-descriptionForeground)">kingu/{v.meta.slug}</span>
				</button>
				<button class="invisible grid size-6 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) group-focus-within:visible group-hover:visible" aria-label="การทำงานของ session" title="การทำงานของ session" onclick={(e) => openMenu(e, v)}>
					<Icon name="menu" size={14} />
				</button>
			</div>
		{:else}
			<p class="px-2 py-1 text-xs text-(--vscode-descriptionForeground)">ยังไม่มี session ของ agent ในโฟลเดอร์นี้</p>
		{/each}
	</div>
</div>

{#if menu}
	{@const m = menu}
	<PopupMenu items={items(m.view)} label={m.view.meta.title} x={m.x} y={m.y} onRun={(node) => node.type === 'item' && run(m.view, node.id)} onClose={() => (menu = null)} />
{/if}
