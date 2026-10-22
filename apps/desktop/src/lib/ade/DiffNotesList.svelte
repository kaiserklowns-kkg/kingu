<script lang="ts">
	// Review notes of a worktree (Orca's Source Control notes shelf): every note with its file and
	// lines (click opens the diff there), edit / delete, and Send to the agent, Copy, Clear.
	import { ask } from '#lib/workbench/messageBox.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { diffKey, splitPath, taskDiffKey } from '#lib/workbench/scm.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { adeLayout } from './adeLayout.svelte.ts';
	import { diffNotes } from './diffNotes.svelte.ts';
	import { locationLabel, sortedNotes, type DiffNote } from './diffNotes.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui.ts';

	/** '' = the folder itself, else a task slug. */
	let { worktree }: { worktree: string } = $props();

	const notes = $derived(sortedNotes(diffNotes.list(worktree)));
	const delivery = $derived(diffNotes.delivery(worktree));
	const sendLabel = $derived(
		delivery === 'cli' ? 'ส่งถึง agent (พิมพ์ลง terminal)' : delivery === 'launch' ? 'เริ่ม agent ใน terminal พร้อมโน้ต' : 'คัดลอกโน้ต'
	);
	const busy = $derived(notes.some((n) => diffNotes.sending[n.id]));
	let editing = $state<string | null>(null);
	let draft = $state('');

	function open(n: DiffNote) {
		const key = worktree ? taskDiffKey(worktree, n.filePath) : diffKey(n.filePath);
		diffNotes.revealRequest = { diffKey: key, line: Math.max(1, n.lineNumber) };
		if (appMode.isAgents) adeLayout.openFile(worktree, key);
		else editors.open(key, { preview: true });
	}

	function edit(n: DiffNote) {
		editing = n.id;
		draft = n.body;
	}

	async function save(n: DiffNote) {
		if (await diffNotes.update(worktree, n.id, draft)) editing = null;
	}

	async function clear() {
		const ok = await ask(`ลบโน้ตรีวิวทั้ง ${notes.length} รายการ?`, { title: 'ล้างโน้ตรีวิว', kind: 'warning', okLabel: 'ลบทั้งหมด', cancelLabel: 'ยกเลิก' });
		if (ok) await diffNotes.clear(worktree);
	}
</script>

{#if notes.length}
	<section aria-label="โน้ตรีวิว" class="space-y-1 px-3 py-2 text-xs">
		<div class="flex items-center gap-1">
			<h3 class="flex-1 text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase">โน้ตรีวิว ({notes.length})</h3>
			<button class={ICON_BUTTON} aria-label="คัดลอกโน้ตทั้งหมด" title="คัดลอกโน้ตทั้งหมด" onclick={() => diffNotes.copy(notes)}><Icon name="copy" size={13} /></button>
			<button class={ICON_BUTTON} aria-label="ล้างโน้ตทั้งหมด" title="ล้างโน้ตทั้งหมด" disabled={busy} onclick={clear}><Icon name="trash" size={13} /></button>
		</div>
		<ul class="space-y-1">
			{#each notes as n (n.id)}
				{@const [name] = splitPath(n.filePath)}
				<li class="group rounded border border-(--vscode-widget-border) px-2 py-1">
					<div class="flex items-center gap-1">
						<button class="min-w-0 flex-1 truncate text-left hover:underline" title="{n.filePath} · {locationLabel(n)} (เปิด diff)" onclick={() => open(n)}>
							<span>{name}</span> <span class="text-(--vscode-descriptionForeground)">{locationLabel(n)}</span>
						</button>
						{#if editing !== n.id}
							<button class={[ICON_BUTTON, 'invisible group-focus-within:visible group-hover:visible']} aria-label="แก้ไขโน้ต" title="แก้ไขโน้ต" onclick={() => edit(n)}><Icon name="edit" size={12} /></button>
							<button class={[ICON_BUTTON, 'invisible group-focus-within:visible group-hover:visible']} aria-label="ลบโน้ต" title="ลบโน้ต" disabled={!!diffNotes.sending[n.id]} onclick={() => diffNotes.remove(worktree, n.id)}><Icon name="trash" size={12} /></button>
						{/if}
					</div>
					{#if editing === n.id}
						<textarea
							class={[INPUT, 'mt-1 min-h-12 resize-y text-xs']}
							aria-label="แก้ไขโน้ต"
							bind:value={draft}
							onkeydown={(e) => {
								if (e.isComposing) return;
								if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), void save(n));
								else if (e.key === 'Escape') (e.preventDefault(), (editing = null));
							}}
						></textarea>
						<div class="mt-1 flex justify-end gap-1">
							<button class={BUTTON_SECONDARY} onclick={() => (editing = null)}>ยกเลิก</button>
							<button class={BUTTON} disabled={!draft.trim()} onclick={() => save(n)}>บันทึก</button>
						</div>
					{:else}
						<p class="line-clamp-3 whitespace-pre-wrap text-(--vscode-foreground)/90">{n.body}</p>
					{/if}
				</li>
			{/each}
		</ul>
		<button class={BUTTON} disabled={busy} title={delivery === 'none' ? 'โฟลเดอร์นี้ไม่มี agent: คัดลอกไปวางเอง' : 'ส่งโน้ตทั้งหมดถึง agent ของงานนี้ แล้วลบโน้ตที่ส่งแล้ว'} onclick={() => diffNotes.send(worktree, notes)}>
			<Icon name="send" size={12} /> {busy ? 'กำลังส่ง…' : sendLabel}
		</button>
	</section>
{/if}
