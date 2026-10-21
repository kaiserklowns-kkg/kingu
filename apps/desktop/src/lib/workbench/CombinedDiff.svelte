<script lang="ts">
	// Every change on one scrolling page (Orca's CombinedDiffViewer): the folder against HEAD, or a
	// task's worktree since its fork point. Each file collapses; Open File jumps to it. Source
	// Control history uses it too (VS Code's multi-diff editor): a commit's or a range's changes and
	// a stash's contents (scm/rangeChanges.ts), each file opening as the diff of its two revisions.
	import { invoke } from '@tauri-apps/api/core';
	import FileIcon from './FileIcon.svelte';
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { fileIcon } from './fileIcons';
	import { parseUnifiedDiff, type DiffFile } from './unifiedDiff';
	import { changesSlug } from './viewers';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { worktreeDir } from '#lib/ade/keys.ts';
	import { fileRevisions, parseHistoryChangesKey } from '#lib/scm/rangeChanges.ts';
	import { stashAction } from '#lib/scm/gitCommands.svelte.ts';
	import { entryKey } from './scmRepos';
	import { refDiffKey } from './scm';
	import { workspace } from './workspace.svelte';
	import { t } from '#lib/i18n/index.ts';

	let { changesKey: key }: { changesKey: string } = $props();
	const slug = $derived(changesSlug(key));
	const history = $derived(parseHistoryChangesKey(key));
	/** A stash's untracked files (their right side is the stash's third parent). */
	let untracked = $state<string[]>([]);

	let files = $state<DiffFile[]>([]);
	let truncated = $state(false);
	let loading = $state(true);
	let error = $state('');
	let collapsed = $state<Record<string, boolean>>({});

	async function load() {
		loading = true;
		error = '';
		try {
			const base = slug ? adeTasks.find(slug)?.meta.base : undefined;
			const h = history;
			if (h?.kind === 'stash') untracked = (await invoke<{ untracked: string[] }>('git_stash_show', { index: h.index, repo: h.repo })).untracked;
			const text = h
				? h.kind === 'range'
					? await invoke<string>('scm_diff_range', { from: h.from, to: h.to, repo: h.repo })
					: await invoke<string>('git_stash_diff', { index: h.index, repo: h.repo })
				: slug
					? await invoke<string>('worktree_diff_text', { slug, base: base ?? 'HEAD' })
					: await invoke<string>('git_diff_text');
			({ files, truncated } = parseUnifiedDiff(text));
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void slug;
		void load();
	});

	const totals = $derived(files.reduce((t, f) => ({ added: t.added + f.added, deleted: t.deleted + f.deleted }), { added: 0, deleted: 0 }));
	const STATUS = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
	const STATUS_COLOR = { added: 'text-[#73C991]', deleted: 'text-[#F48771]', renamed: 'text-[#73C991]', modified: 'text-[#E2C08D]' };
	/** A history file opens as the diff of its two revisions; others as the file. */
	function open(f: DiffFile) {
		const h = history;
		if (!h) return editors.open(slug ? `${worktreeDir(slug)}/${f.path}` : f.path, { preview: false });
		const { left, right } = fileRevisions(h, h.kind === 'stash' && untracked.includes(f.path));
		const rel = entryKey(h.repo, f.path, workspace.folders);
		const before = f.oldPath ? entryKey(h.repo, f.oldPath, workspace.folders) : null;
		editors.open(refDiffKey(left, right, rel, before), { preview: false });
	}
</script>

<div class="flex h-full flex-col bg-(--vscode-editor-background) text-[13px]">
	<header class="flex h-9 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-4">
		<Icon name="git" size={15} />
		<span class="font-medium">{history ? history.title : slug ? `การเปลี่ยนแปลงของ kingu/${slug}` : 'การเปลี่ยนแปลงทั้งหมด'}</span>
		<span class="font-mono text-xs"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>
		<span class="text-xs text-(--vscode-descriptionForeground)">{files.length} ไฟล์</span>
		<span class="flex-1"></span>
		{#if history?.kind === 'stash'}
			{@const s = history}
			<button class="rounded-md px-2 py-0.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => stashAction(s.repo, s.index, 'apply')}>{t('scmGit.stashApply')}</button>
			<button class="rounded-md px-2 py-0.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => stashAction(s.repo, s.index, 'pop')}>{t('scmGit.stashPop')}</button>
			<button class="rounded-md px-2 py-0.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => stashAction(s.repo, s.index, 'drop')}>{t('scmGit.stashDrop')}</button>
		{/if}
		<button class="rounded-md px-2 py-0.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (collapsed = Object.fromEntries(files.map((f) => [f.path, true])))}>ยุบทั้งหมด</button>
		<button class="rounded-md px-2 py-0.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (collapsed = {})}>กางทั้งหมด</button>
		<button class="grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label="รีเฟรช" title="รีเฟรช" onclick={load}><Icon name="refresh" size={14} /></button>
	</header>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if error}
			<p class="p-6 text-(--vscode-errorForeground)">โหลด diff ไม่ได้: {error}</p>
		{:else if loading && !files.length}
			<p class="p-6 text-(--vscode-descriptionForeground)">กำลังโหลด…</p>
		{:else if !files.length}
			<p class="p-6 text-(--vscode-descriptionForeground)">ไม่มีการเปลี่ยนแปลง</p>
		{/if}
		{#each files as f (f.path)}
			{@const shut = collapsed[f.path]}
			<section class="border-b border-(--vscode-widget-border)" aria-label={f.path}>
				<div class="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-(--vscode-widget-border) bg-(--vscode-editorGroupHeader-tabsBackground) px-3">
					<button class="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={!shut} onclick={() => (collapsed[f.path] = !shut)}>
						<Icon name={shut ? 'chevronRight' : 'chevronDown'} size={14} />
						<FileIcon icon={fileIcon(f.path.slice(f.path.lastIndexOf('/') + 1))} />
						<span class="truncate">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
						<span class={['font-semibold', STATUS_COLOR[f.status]]}>{STATUS[f.status]}</span>
						<span class="font-mono text-xs"><span class="text-[#73C991]">+{f.added}</span> <span class="text-[#F48771]">−{f.deleted}</span></span>
					</button>
					{#if f.status !== 'deleted' || history}
						<button class="grid size-6 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={history ? `${t('scmGraph.openDiff')} ${f.path}` : `เปิดไฟล์ ${f.path}`} title={history ? t('scmGraph.openDiff') : 'เปิดไฟล์'} onclick={() => open(f)}><Icon name="goToFile" size={14} /></button>
					{/if}
				</div>
				{#if !shut}
					{#if f.binary}
						<p class="px-4 py-2 text-xs text-(--vscode-descriptionForeground)">ไฟล์ binary</p>
					{:else if !f.hunks.length}
						<p class="px-4 py-2 text-xs text-(--vscode-descriptionForeground)">{f.status === 'renamed' ? 'ย้ายไฟล์โดยไม่แก้เนื้อหา' : 'ไม่มีเนื้อหาที่เปลี่ยน'}</p>
					{/if}
					<table class="kg-selectable w-full border-collapse font-mono text-[12px] leading-[19px]">
						{#each f.hunks as h, hi (hi)}
							<tbody>
								<tr><td colspan="3" class="bg-(--vscode-editorInfo-foreground)/10 px-3 text-(--vscode-descriptionForeground)">{h.header}</td></tr>
								{#each h.lines as l, li (li)}
									<tr class={l.kind === 'add' ? 'bg-[#73C991]/12' : l.kind === 'del' ? 'bg-[#F48771]/12' : ''}>
										<td class="w-12 pr-2 text-right text-(--vscode-descriptionForeground)/70 select-none">{l.old ?? ''}</td>
										<td class="w-12 pr-2 text-right text-(--vscode-descriptionForeground)/70 select-none">{l.new ?? ''}</td>
										<td class="pr-4 whitespace-pre"><span class="inline-block w-4 select-none opacity-60">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>{l.text}</td>
									</tr>
								{/each}
							</tbody>
						{/each}
					</table>
				{/if}
			</section>
		{/each}
		{#if truncated}
			<p class="px-4 py-3 text-xs text-(--vscode-editorWarning-foreground)">diff ยาวเกิน 2 MB แสดงเฉพาะส่วนแรก — ดูไฟล์ที่เหลือได้ที่ Source Control</p>
		{/if}
	</div>
</div>
