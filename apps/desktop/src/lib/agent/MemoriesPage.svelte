<script lang="ts">
	// Settings › Memories (Cursor's Memories): what "Remember this" saved for the open folder, the
	// `## Memories` bullets of CLAUDE.local.md (personal, read by Claude Code) and AGENTS.md
	// (shared, read by the chat rules). Each one can be edited or deleted; Rust (memories.rs)
	// refuses a change when the file changed since this list was read.
	import Icon from '#lib/workbench/Icon.svelte';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { chatExtras, MEMORY_FILES, type Memory, type MemoryFile } from './chatExtras.svelte.ts';

	let list = $state<Memory[]>([]);
	let loading = $state(false);
	let error = $state('');
	/** The memory being edited (`file:index`) and its text. */
	let editing = $state<string | null>(null);
	let editText = $state('');

	const keyOf = (m: Memory) => `${m.file}:${m.index}`;
	const byFile = $derived(MEMORY_FILES.map((file) => ({ file, rows: list.filter((m) => m.file === file) })));

	async function load() {
		if (!workspace.root) return void (list = []);
		loading = true;
		error = '';
		try {
			list = await chatExtras.listMemories();
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void workspace.root;
		void load();
	});

	async function save(m: Memory) {
		const text = editText.trim();
		editing = null;
		if (!text || text === m.text) return;
		await change(m, text);
	}

	async function remove(m: Memory) {
		if (!(await ask(t('chatExtras.memories.deleteConfirm', { text: m.text.slice(0, 200) }), { kind: 'warning', okLabel: t('common.delete') }))) return;
		await change(m, null);
	}

	async function change(m: Memory, text: string | null) {
		try {
			await chatExtras.changeMemory(m, text);
		} catch (e) {
			error = String(e);
		}
		await load();
	}

	function openFile(file: MemoryFile) {
		systemSettings.close();
		editors.open(file, { preview: false });
	}

	const SECTION = 'mt-7 mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'rounded-xl border border-(--vscode-widget-border)';
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BUTTON = 'flex h-8 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-3 text-[13px] hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
	const ICON = 'grid size-6 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-4xl px-8 pt-10 pb-24">
		<div class="flex items-center gap-2">
			<h1 class="flex flex-1 items-center gap-2 text-2xl leading-tight font-semibold"><Icon name="bookmark" size={20} />{t('chatExtras.memories.title')}</h1>
			<button class={BUTTON} disabled={loading || !workspace.root} onclick={load} aria-label={t('chatExtras.memories.refresh')} title={t('chatExtras.memories.refresh')}>
				<span class={['grid place-items-center', loading && 'animate-spin']}><Icon name="refresh" size={14} /></span>
			</button>
		</div>
		<p class={['mt-2 text-[13px] leading-5', MUTED]}>{t('chatExtras.memories.intro')}</p>
		{#if error}<p class="mt-3 text-[13px] text-(--vscode-errorForeground)" role="alert">{error}</p>{/if}
		{#if !workspace.root}
			<p class={['mt-6', MUTED]}>{t('chatExtras.memories.noFolder')}</p>
		{:else}
			{#each byFile as g (g.file)}
				<div class={SECTION}>
					<span class="flex-1">{g.file} · {g.file === 'AGENTS.md' ? t('chatExtras.remember.shared') : t('chatExtras.remember.local')}</span>
					<button class="normal-case text-(--vscode-textLink-foreground) hover:underline" onclick={() => openFile(g.file)}>{t('chatExtras.memories.openFile')}</button>
				</div>
				<ul class={CARD}>
					{#each g.rows as m (keyOf(m))}
						<li class="group/row flex items-start gap-2 border-b border-(--vscode-widget-border) px-3 py-2 last:border-b-0">
							{#if editing === keyOf(m)}
								<input
									class="h-7 min-w-0 flex-1 rounded-sm border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1.5 text-[13px] text-(--vscode-input-foreground) outline-none"
									aria-label={t('chatExtras.memories.edit')}
									bind:value={editText}
									onkeydown={(e) => {
										if (e.key === 'Enter' && !e.isComposing) void save(m);
										else if (e.key === 'Escape') editing = null;
									}}
									onblur={() => void save(m)}
									{@attach (el) => el.focus()}
								/>
							{:else}
								<span class="min-w-0 flex-1 text-[13px] leading-5 break-words">{m.text}</span>
								<span class="flex shrink-0 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
									<button class={ICON} aria-label={t('chatExtras.memories.edit')} title={t('chatExtras.memories.edit')} onclick={() => ((editText = m.text), (editing = keyOf(m)))}><Icon name="edit" size={13} /></button>
									<button class={ICON} aria-label={t('common.delete')} title={t('common.delete')} onclick={() => remove(m)}><Icon name="trash" size={13} /></button>
								</span>
							{/if}
						</li>
					{:else}
						<li class={['px-3 py-2 text-[13px]', MUTED]}>{t('chatExtras.memories.none')}</li>
					{/each}
				</ul>
			{/each}
		{/if}
	</div>
</div>
