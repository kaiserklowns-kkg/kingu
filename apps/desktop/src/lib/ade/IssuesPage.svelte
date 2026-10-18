<script lang="ts">
	// Issues page (Agents layout center, from the side bar): the folder's open GitHub issues via gh,
	// filtered to mine or all, by label and search. A row starts a task (a small confirm with the base
	// branch and run mode, like the composer) or opens the issue on GitHub; a row that already has a
	// task links to it.
	import { onMount } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import type { RunMode } from './agentCli.ts';
	import { issues, defaultBase, defaultRunMode } from './issues.svelte.ts';
	import type { Issue } from './issues.ts';
	import { timeAgo } from './model.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui.ts';

	let label = $state(issues.filter.label);
	let search = $state(issues.filter.search);
	let base = $state('');
	let mode = $state<RunMode>(defaultRunMode());
	let busy = $state(false);
	const cliSetting = $derived(settings.get<string>('kingu.agent.cli') ?? '');

	onMount(() => {
		if (!issues.loaded) void issues.load();
		void adeTasks.refreshBranches();
	});

	function setMine(mine: boolean) {
		if (issues.filter.mine === mine) return;
		issues.filter.mine = mine;
		void issues.load();
	}

	function apply(e: Event) {
		e.preventDefault();
		issues.filter.label = label;
		issues.filter.search = search;
		void issues.load();
	}

	function confirm(issue: Issue) {
		issues.confirming = issue;
		base = defaultBase();
		mode = defaultRunMode();
	}

	async function start(issue: Issue) {
		busy = true;
		try {
			await issues.start(issue, base, mode);
		} finally {
			busy = false;
		}
	}

	const updated = (iso: string) => {
		const t = Date.parse(iso);
		return Number.isNaN(t) ? '' : timeAgo(t, adeTasks.now);
	};
	const TAB = 'h-6 rounded-sm px-2 text-xs';
</script>

<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--vscode-widget-border) px-4 py-2">
		<h1 class="text-sm font-semibold">Issues</h1>
		<div class="flex items-center gap-0.5" role="group" aria-label="ตัวกรอง">
			<button class={[TAB, issues.filter.mine ? 'bg-(--vscode-list-activeSelectionBackground)/40' : 'hover:bg-(--vscode-toolbar-hoverBackground)']} aria-pressed={issues.filter.mine} onclick={() => setMine(true)}>มอบหมายให้ฉัน</button>
			<button class={[TAB, !issues.filter.mine ? 'bg-(--vscode-list-activeSelectionBackground)/40' : 'hover:bg-(--vscode-toolbar-hoverBackground)']} aria-pressed={!issues.filter.mine} onclick={() => setMine(false)}>เปิดอยู่ทั้งหมด</button>
		</div>
		<form class="flex min-w-0 flex-1 items-center gap-1.5 text-xs" onsubmit={apply}>
			<input class={[INPUT, 'max-w-36']} placeholder="label" aria-label="label" bind:value={label} />
			<input class={[INPUT, 'max-w-64']} placeholder="ค้นหา (Enter)" aria-label="ค้นหา issue" bind:value={search} />
			<button type="submit" class="sr-only">ค้นหา</button>
		</form>
		<button class={ICON_BUTTON} aria-label="รีเฟรช" title="รีเฟรช" disabled={issues.loading} onclick={() => issues.load()}><Icon name="refresh" size={16} /></button>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto p-4">
		{#if issues.error}
			<div class="mb-3 rounded border border-(--vscode-errorForeground) px-3 py-2 text-xs" role="alert">
				<p class="text-(--vscode-errorForeground)">โหลด issues ไม่ได้: {issues.error}</p>
			</div>
		{/if}
		{#if issues.loading && !issues.list.length}
			<p class="text-xs text-(--vscode-descriptionForeground)">กำลังโหลด issues…</p>
		{:else if issues.loaded && !issues.list.length && !issues.error}
			<p class="text-xs text-(--vscode-descriptionForeground)">
				ไม่มี issue ที่เปิดอยู่{issues.filter.mine ? 'ที่มอบหมายให้คุณ' : ''}{issues.filter.label || issues.filter.search ? ' ตามตัวกรองนี้' : ''}
			</p>
		{:else}
			<ul class={['space-y-1.5', issues.loading && 'opacity-60']} aria-label="รายการ issue" aria-busy={issues.loading}>
				{#each issues.list as issue (issue.number)}
					{@const taskSlug = issues.tasks.get(issue.number)}
					{@const task = taskSlug ? adeTasks.find(taskSlug) : undefined}
					<li class="rounded border border-(--vscode-widget-border) px-3 py-2 text-xs">
						<div class="flex items-start gap-3">
							<span class="shrink-0 font-mono text-(--vscode-descriptionForeground)">#{issue.number}</span>
							<div class="min-w-0 flex-1 space-y-1">
								<p class="truncate text-[13px]" title={issue.title}>{issue.title}</p>
								<p class="flex flex-wrap items-center gap-1.5 text-(--vscode-descriptionForeground)">
									{#each issue.labels as l (l.name)}
										<span class="rounded-full border px-1.5 text-[10px] leading-4" style:border-color={/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : undefined}>{l.name}</span>
									{/each}
									<span>อัปเดต {updated(issue.updated_at)}</span>
									{#if issue.assignees.length}<span>· {issue.assignees.map((a) => `@${a}`).join(', ')}</span>{/if}
									{#if task}
										<span>·</span>
										<button class="font-mono text-(--vscode-textLink-foreground) hover:underline" onclick={() => adeLayout.show(task.meta.slug)}>kingu/{task.meta.slug}</button>
									{/if}
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-1">
								{#if task}
									<button class={BUTTON_SECONDARY} onclick={() => adeLayout.show(task.meta.slug)}>เปิดงาน</button>
								{:else}
									<button class={BUTTON} disabled={!!issues.confirming && issues.confirming.number === issue.number} onclick={() => confirm(issue)}><Icon name="play" size={12} /> Start task</button>
								{/if}
								<button class={ICON_BUTTON} aria-label="เปิด #{issue.number} บน GitHub" title="Open on GitHub" onclick={() => issues.open(issue)}><Icon name="openExternal" size={14} /></button>
							</div>
						</div>
						{#if issues.confirming?.number === issue.number}
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape from any field) -->
							<form
								class="mt-2 flex flex-wrap items-center gap-2 border-t border-(--vscode-widget-border) pt-2"
								onsubmit={(e) => (e.preventDefault(), start(issue))}
								onkeydown={(e) => e.key === 'Escape' && (issues.confirming = null)}
							>
								<label class="flex items-center gap-1">
									<span class="text-(--vscode-descriptionForeground)">แตกจาก</span>
									<select class={[INPUT, 'w-auto py-0.5']} bind:value={base} disabled={busy} aria-label="base branch">
										{#each adeTasks.branches as b (b)}<option value={b}>{b}</option>{/each}
										{#if !adeTasks.branches.length}<option value="">HEAD</option>{/if}
									</select>
								</label>
								<label class="flex items-center gap-1">
									<span class="text-(--vscode-descriptionForeground)">รันแบบ</span>
									<select class={[INPUT, 'w-auto py-0.5']} bind:value={mode} disabled={busy} aria-label="วิธีรัน agent">
										<option value="terminal">Terminal · {cliSetting || 'claude'}</option>
										<option value="timeline">Timeline</option>
									</select>
								</label>
								<span class="flex-1"></span>
								<button type="submit" class={BUTTON} disabled={busy}>{busy ? 'กำลังสร้าง…' : 'สร้างและเริ่ม'}</button>
								<button type="button" class={BUTTON_SECONDARY} disabled={busy} onclick={() => (issues.confirming = null)}>ยกเลิก</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
