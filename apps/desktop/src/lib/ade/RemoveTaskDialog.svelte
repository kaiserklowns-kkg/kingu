<script lang="ts">
	// Remove task (Orca's Delete Workspace dialog): what goes (title, worktree path, branch), how many
	// uncommitted or untracked changes it has with the first paths, what happens to the branch, and
	// "don't ask again" (kingu.worktree.confirmRemove). Confirming removes the changes it showed.
	import { invoke } from '@tauri-apps/api/core';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import type { GitStatus } from '#lib/workbench/scm.ts';
	import AdeDialog from './AdeDialog.svelte';
	import { worktreeDir } from './keys.ts';
	import { adeTasks } from './tasks.svelte.ts';
	import { BUTTON, BUTTON_SECONDARY, LETTER_COLOR } from './ui.ts';
	import { BRANCH_CHOICES, dirtyLabel, dirtyPreview, type BranchRemoval } from './worktreeSettings.ts';

	let { slug, onClose }: { slug: string; onClose: () => void } = $props();

	const meta = $derived(adeTasks.find(slug)?.meta);
	const hasWorktree = $derived(adeTasks.hasWorktree(slug));
	const branch = $derived(adeTasks.branchOf(slug));
	let deleteBranch = $state<BranchRemoval>('safe');
	let dontAsk = $state(false);
	let busy = $state(false);
	let showFiles = $state(false);
	/** null while checking; `error` when git status failed. */
	let changes = $state<ReturnType<typeof dirtyPreview> | null>(null);
	let checkError = $state('');

	$effect(() => {
		const s = slug;
		deleteBranch = adeTasks.defaultBranchRemoval(s);
		if (!adeTasks.hasWorktree(s)) return;
		invoke<GitStatus | null>('git_status', { slug: s })
			.then((st) => (changes = dirtyPreview(st?.entries ?? [])))
			.catch((e) => (checkError = String(e)));
	});

	async function confirm() {
		// Orca: the confirm removes the changes the dialog showed; unknown changes still ask.
		const task = slug;
		const opts = { deleteBranch, force: !!changes?.count };
		const remember = dontAsk;
		busy = true;
		// Orca's background removal: the dialog goes, the card shows "Removing…" until git is done.
		onClose();
		const removed = await adeTasks.removeConfirmed(task, opts);
		if (!removed) return;
		if (remember) {
			try {
				await settings.set('kingu.worktree.confirmRemove', false, 'user');
				status.flash('ครั้งหน้าจะลบโดยไม่ถาม เปลี่ยนได้ใน Settings: kingu.worktree.confirmRemove', 8000);
			} catch (e) {
				status.flash(`บันทึกการตั้งค่าไม่ได้: ${e}`, 8000);
			}
		}
	}
</script>

<AdeDialog title="ลบงาน" {busy} {onClose}>
	{#if meta}
		<div class="space-y-3">
			<p>
				ลบ <span class="font-semibold">{meta.title}</span>
				{hasWorktree ? ' ออกจาก git และลบโฟลเดอร์ worktree ของมัน' : ' ออกจากรายการงาน (ไม่มีโฟลเดอร์ worktree แล้ว)'}
			</p>
			<div class="space-y-0.5 rounded border border-(--vscode-widget-border) px-2.5 py-1.5 text-xs">
				<div class="truncate">{meta.title}</div>
				{#if hasWorktree}<div class="truncate font-mono text-(--vscode-descriptionForeground)" title="{workspace.root}/{worktreeDir(slug)}">{worktreeDir(slug)}</div>{/if}
				<div class="truncate font-mono text-(--vscode-descriptionForeground)">{branch}</div>
			</div>

			{#if hasWorktree}
				<div class="text-xs">
					{#if checkError}
						<span class="text-(--vscode-descriptionForeground)">ตรวจการเปลี่ยนแปลงไม่ได้: {checkError}</span>
					{:else if !changes}
						<span class="text-(--vscode-descriptionForeground)">กำลังตรวจการเปลี่ยนแปลง…</span>
					{:else if !changes.count}
						<span class="text-(--vscode-descriptionForeground)">{dirtyLabel(0)}</span>
					{:else}
						<button class="text-(--vscode-editorWarning-foreground) hover:underline" aria-expanded={showFiles} onclick={() => (showFiles = !showFiles)}>{dirtyLabel(changes.count)} {showFiles ? '▾' : '▸'}</button>
						{#if showFiles}
							<ul class="mt-1 space-y-0.5 rounded border border-(--vscode-widget-border) px-2 py-1 font-mono" aria-label="ไฟล์ที่เปลี่ยน">
								{#each changes.files as f (f.path)}
									<li class="flex gap-2"><span class={['w-3 shrink-0 text-center', LETTER_COLOR[f.letter === 'U' ? '?' : f.letter] ?? '']}>{f.letter}</span><span class="truncate" title={f.path}>{f.path}</span>{#if f.conflict}<span class="text-(--vscode-errorForeground)">conflict</span>{/if}</li>
								{/each}
								{#if changes.more}<li class="text-(--vscode-descriptionForeground)">และอีก {changes.more} ไฟล์</li>{/if}
							</ul>
						{/if}
						<p class="mt-1 text-(--vscode-editorWarning-foreground)">การแก้ไขที่ยังไม่ commit และไฟล์ untracked จะถูกลบถาวร</p>
					{/if}
				</div>

				<fieldset class="space-y-1 text-xs">
					<legend class="mb-1 text-(--vscode-descriptionForeground)">branch <span class="font-mono">{branch}</span></legend>
					{#each BRANCH_CHOICES as c (c.id)}
						<label class="flex items-center gap-1.5"><input type="radio" name="branch-{slug}" value={c.id} bind:group={deleteBranch} disabled={busy} /> {c.label}</label>
					{/each}
				</fieldset>
			{/if}

			<label class="flex items-center gap-1.5 text-xs">
				<input type="checkbox" bind:checked={dontAsk} disabled={busy} />
				ไม่ต้องถามอีก (ลบทันทีครั้งหน้า)
			</label>
		</div>
	{/if}
	{#snippet footer()}
		<button class={BUTTON_SECONDARY} disabled={busy} onclick={onClose}>ยกเลิก</button>
		<button class={BUTTON} data-autofocus disabled={busy || (hasWorktree && !changes && !checkError)} onclick={confirm}>
			{busy ? 'กำลังลบ…' : changes?.count ? 'ลบทิ้งพร้อมการแก้ไข' : 'ลบงาน'}
		</button>
	{/snippet}
</AdeDialog>
