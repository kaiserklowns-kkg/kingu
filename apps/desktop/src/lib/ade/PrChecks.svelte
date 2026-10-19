<script lang="ts">
	// Orca's Checks: the task branch's pull request and its CI runs (`gh pr view`), shared by the
	// task page's review and the ADE right side bar's Checks tab. Polls while checks run. Also
	// lands the PR the Orca way: merge, "fix failing checks" and the review comments.
	import { untrack } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { brokenChecks, prLine, sortChecks, summarizeChecks, type CheckState } from './prChecks.ts';
	import PrComments from './PrComments.svelte';
	import PrMerge from './PrMerge.svelte';
	import { prStatuses } from './prStatus.svelte';
	import { adeTasks } from './tasks.svelte';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { BUTTON_SECONDARY, ICON_BUTTON } from './ui.ts';

	/** `slug` '' is the folder itself: the PR of its checked-out branch. */
	let { slug, title = true }: { slug: string; title?: boolean } = $props();

	$effect(() => {
		const s = slug;
		untrack(() => {
			if (!adeTasks.gh) void adeTasks.checkGh();
		});
		if (!adeTasks.gh?.authenticated) return;
		return untrack(() => prStatuses.watch(s));
	});

	const CHECK_DOT: Record<CheckState, string> = {
		success: 'bg-[#73C991]',
		failure: 'bg-(--vscode-errorForeground)',
		pending: 'bg-(--vscode-editorInfo-foreground) animate-pulse',
		cancelled: 'bg-(--vscode-descriptionForeground)',
		neutral: 'bg-(--vscode-descriptionForeground)',
		skipped: 'bg-(--vscode-descriptionForeground)'
	};
	const entry = $derived(prStatuses.bySlug[slug]);
	const branch = $derived(slug ? adeTasks.branchOf(slug) : (scm.repo?.branch ?? 'branch นี้'));
	const pr = $derived(entry?.pr);
</script>

<div class="space-y-1.5 text-xs">
	<div class="flex items-center gap-1 text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase">
		<span class="flex-1">{title ? 'Checks' : ''}</span>
		<button class={ICON_BUTTON} aria-label="รีเฟรช checks" title="รีเฟรช" disabled={entry?.loading || !adeTasks.gh?.authenticated} onclick={() => prStatuses.refresh(slug)}><Icon name="refresh" size={14} /></button>
	</div>
	{#if adeTasks.gh?.provider === 'gitlab' && !adeTasks.gh.authenticated}
		<p class="text-(--vscode-descriptionForeground)">{adeTasks.gh.detail}</p>
	{:else if adeTasks.gh && !adeTasks.gh.installed}
		<p class="text-(--vscode-descriptionForeground)">ต้องมี GitHub CLI เพื่อดู PR และ CI: <code>brew install gh</code> แล้ว <code>gh auth login</code></p>
	{:else if adeTasks.gh && !adeTasks.gh.authenticated}
		<p class="text-(--vscode-descriptionForeground)">gh ยังไม่ได้เข้าสู่ระบบ: รัน <code>gh auth login</code> ในเทอร์มินัล</p>
	{:else if pr}
		{@const sum = summarizeChecks(pr.checks)}
		<a class="flex items-center gap-1.5 hover:underline" href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
			<Icon name="pullRequest" size={12} /><span class="truncate">#{pr.number} {pr.title}</span>
		</a>
		<p class="text-(--vscode-descriptionForeground)">
			{prLine(pr)}{#if sum.total} · ผ่าน {sum.passed}/{sum.total}{#if sum.pending} · กำลังรัน {sum.pending}{/if}{#if sum.failed} · ล้มเหลว {sum.failed}{/if}{/if}
		</p>
		<PrMerge {slug} {pr} />
		{#each sortChecks(pr.checks) as c (c.name)}
			<div class="flex items-center gap-1.5">
				<span class={['size-2 shrink-0 rounded-full', CHECK_DOT[c.state]]} title={c.state}></span>
				{#if c.url}<a class="min-w-0 flex-1 truncate hover:underline" href={c.url} target="_blank" rel="noreferrer">{c.name}</a>{:else}<span class="min-w-0 flex-1 truncate">{c.name}</span>{/if}
				<span class="shrink-0 text-(--vscode-descriptionForeground)">{c.state}</span>
			</div>
		{:else}
			<p class="text-(--vscode-descriptionForeground)">PR นี้ยังไม่มี CI check</p>
		{/each}
		{#if pr.state === 'OPEN' && brokenChecks(pr.checks).length}
			<button class={BUTTON_SECONDARY} disabled={!!adeTasks.busy[slug]} title={slug ? 'ส่ง check ที่ล้มเหลวพร้อม log ให้ agent ของงานนี้แก้' : 'คัดลอก prompt ไปวางให้ agent'} onclick={() => adeTasks.fixChecks(slug)}>
				<Icon name="send" size={12} /> {slug ? 'ให้ agent แก้ checks ที่ล้มเหลว' : 'คัดลอก prompt แก้ checks'}
			</button>
		{/if}
		{#if pr.state === 'OPEN'}
			<div class="border-t border-(--vscode-widget-border) pt-2"><PrComments {slug} /></div>
		{/if}
	{:else if entry?.error}
		<p class="text-(--vscode-errorForeground)">{entry.error}</p>
	{:else if entry && !entry.loading}
		<p class="text-(--vscode-descriptionForeground)">{branch} ยังไม่มี pull request</p>
	{:else}
		<p class="text-(--vscode-descriptionForeground)">กำลังอ่านสถานะ PR…</p>
	{/if}
</div>
