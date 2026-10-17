<script lang="ts">
	// Source Control view (VS Code scmViewPane): commit input, Commit button, then the
	// "Staged Changes" and "Changes" groups. Clicking a file opens its diff against HEAD.
	import Icon, { type IconName } from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { keyLabel } from './keys';
	import { diffKey, splitPath, type Resource } from './scm';
	import { scm } from './scm.svelte';

	type Confirm = { key: string; paths: string[]; untracked: boolean; text: string };

	let open = $state({ staged: true, changes: true });
	let selected = $state<string | null>(null);
	let confirming = $state<Confirm | null>(null);
	let input: HTMLTextAreaElement | undefined = $state();

	$effect(() => {
		void scm.refresh();
	});

	const mac = keyLabel('cmd+a').startsWith('⌘');
	const commitKey = mac ? '⌘Enter' : 'Ctrl+Enter';
	const placeholder = $derived(`Message (${commitKey} to commit on '${scm.repo?.branch ?? scm.repo?.head ?? 'HEAD'}')`);

	// Grows with the message up to ~10 lines, like VS Code's SCM input.
	$effect(() => {
		void scm.message;
		if (!input) return;
		input.style.height = 'auto';
		input.style.height = `${Math.min(input.scrollHeight, 10 * 18 + 8)}px`;
	});

	function onInputKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			void scm.commit();
		}
	}

	const rowKey = (r: Resource) => `${r.staged ? 's' : 'w'}:${r.entry.path}`;

	function askDiscard(key: string, resources: Resource[]) {
		const untracked = resources.some((r) => r.entry.worktree === '?');
		const paths = resources.map((r) => r.entry.path);
		const name = resources.length === 1 ? splitPath(paths[0])[0] : `${resources.length} ไฟล์`;
		const text = untracked
			? `ลบ ${name} ถาวร? ไฟล์ที่ยังไม่ track จะถูกลบและกู้คืนไม่ได้`
			: `ทิ้งการแก้ไขใน ${name}? กู้คืนไม่ได้`;
		confirming = { key, paths, untracked, text };
	}

	async function doDiscard() {
		const c = confirming;
		confirming = null;
		if (c) await scm.discard(c.paths, c.untracked);
	}

	type Action = { icon: IconName; label: string; run: () => unknown; hidden?: boolean };

	function rowActions(r: Resource): Action[] {
		const path = r.entry.path;
		return [
			{ icon: 'goToFile', label: 'Open File', run: () => editors.open(path, { preview: false }), hidden: r.deleted },
			{ icon: 'discard', label: 'Discard Changes', run: () => askDiscard(rowKey(r), [r]), hidden: r.staged },
			r.staged
				? { icon: 'minus', label: 'Unstage Changes', run: () => scm.unstage([path]) }
				: { icon: 'plus', label: 'Stage Changes', run: () => scm.stage([path]) }
		];
	}
</script>

{#snippet actionButtons(actions: Action[])}
	{#each actions as a (a.label)}
		{#if !a.hidden}
			<button
				aria-label={a.label}
				title={a.label}
				disabled={scm.busy}
				class="grid size-5 place-items-center rounded text-(--vscode-icon-foreground) hover:bg-white/10"
				onclick={(e) => {
					e.stopPropagation();
					void a.run();
				}}
			>
				<Icon name={a.icon} size={16} />
			</button>
		{/if}
	{/each}
{/snippet}

{#snippet confirmBox(c: Confirm)}
	<div role="alertdialog" aria-label="ยืนยันการทิ้งการแก้ไข" class="mx-2 my-1 flex flex-col gap-1.5 rounded border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-2">
		<p>{c.text}</p>
		<div class="flex justify-end gap-1.5">
			<button class="rounded-sm px-2 py-0.5 hover:bg-white/10" onclick={() => (confirming = null)}>Cancel</button>
			<!-- svelte-ignore a11y_autofocus -->
			<button
				autofocus
				class="rounded-sm bg-(--vscode-button-background) px-2 py-0.5 text-(--vscode-button-foreground) hover:brightness-110"
				onclick={doDiscard}
			>
				{c.untracked ? 'Delete File' : 'Discard Changes'}
			</button>
		</div>
	</div>
{/snippet}

{#snippet group(id: 'staged' | 'changes', title: string, resources: Resource[], actions: Action[])}
	<div class="group/header flex h-(--kg-row-height) shrink-0 items-center pr-2 font-bold text-[11px] uppercase text-(--vscode-sideBarTitle-foreground) hover:bg-(--vscode-list-hoverBackground)">
		<button class="flex h-full min-w-0 flex-1 items-center gap-0.5 pl-0.5 text-left" aria-expanded={open[id]} onclick={() => (open[id] = !open[id])}>
			<Icon name={open[id] ? 'chevronDown' : 'chevronRight'} size={16} />
			<span class="truncate">{title}</span>
		</button>
		<span class="hidden items-center gap-0.5 group-hover/header:flex group-focus-within/header:flex">{@render actionButtons(actions)}</span>
		<span class="ml-1 min-w-[18px] rounded-full bg-(--vscode-badge-background) px-1.5 text-center text-[11px] leading-[18px] font-normal text-(--vscode-badge-foreground)">{resources.length}</span>
	</div>
	{#if confirming?.key === `group:${id}`}{@render confirmBox(confirming)}{/if}
	{#if open[id]}
		{#each resources as r (rowKey(r))}
			{@const key = rowKey(r)}
			{@const [name, dir] = splitPath(r.entry.path)}
			<div
				class={[
					'group/row flex h-(--kg-row-height) items-center pr-2 leading-(--kg-row-height)',
					selected === key
						? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)'
						: editors.active === diffKey(r.entry.path)
							? 'bg-(--vscode-list-inactiveSelectionBackground)'
							: 'hover:bg-(--vscode-list-hoverBackground)'
				]}
			>
				<button
					class="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-5 text-left"
					title={r.entry.orig_path ? `${r.entry.orig_path} → ${r.entry.path}` : r.entry.path}
					onclick={() => {
						selected = key;
						editors.openDiff(r.entry.path, { preview: true });
					}}
					ondblclick={() => editors.openDiff(r.entry.path, { preview: false })}
				>
					<span class={['shrink-0 truncate', r.deleted && 'line-through']}>{name}</span>
					{#if dir}<span class="truncate text-[0.9em] text-(--vscode-descriptionForeground)">{dir}</span>{/if}
				</button>
				<span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex">{@render actionButtons(rowActions(r))}</span>
				<span class="w-4 shrink-0 text-center text-xs font-semibold" style:color={r.color} title={r.entry.conflict ? 'Conflict' : undefined}>{r.letter}</span>
			</div>
			{#if confirming?.key === key}{@render confirmBox(confirming)}{/if}
		{/each}
	{/if}
{/snippet}

<section class="flex min-h-0 flex-1 flex-col">
	{#if !scm.loaded}
		<p class="px-5 py-1 text-(--vscode-descriptionForeground)">กำลังอ่านสถานะ git...</p>
	{:else if !scm.repo}
		<p class="px-5 py-1 text-(--vscode-descriptionForeground)">The folder currently open doesn't have a git repository.</p>
	{:else}
		<div class="flex shrink-0 flex-col gap-1.5 px-2 pt-1 pb-2">
			<textarea
				bind:this={input}
				bind:value={scm.message}
				aria-label="Source Control commit message"
				{placeholder}
				rows="1"
				spellcheck="false"
				class="block max-h-[188px] min-h-[26px] w-full resize-none rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 py-[3px] leading-[18px] text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
				onkeydown={onInputKey}
			></textarea>
			<button
				class="flex h-[26px] items-center justify-center gap-1 rounded-sm bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:brightness-110 disabled:opacity-50"
				disabled={scm.busy}
				title="Commit ({commitKey})"
				onclick={() => scm.commit()}
			>
				<Icon name="check" size={16} />Commit
			</button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if scm.groups.staged.length}
				{@render group('staged', 'Staged Changes', scm.groups.staged, [
					{ icon: 'minus', label: 'Unstage All Changes', run: () => scm.unstage(scm.groups.staged.map((r) => r.entry.path)) }
				])}
			{/if}
			{@render group('changes', 'Changes', scm.groups.changes, [
				{ icon: 'discard', label: 'Discard All Changes', run: () => askDiscard('group:changes', scm.groups.changes), hidden: !scm.groups.changes.length },
				{ icon: 'plus', label: 'Stage All Changes', run: () => scm.stage(scm.groups.changes.map((r) => r.entry.path)), hidden: !scm.groups.changes.length }
			])}
		</div>
	{/if}
</section>
