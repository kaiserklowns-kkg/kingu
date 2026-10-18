<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import FileIcon from './FileIcon.svelte';
	import { scm } from './scm.svelte';
	import { entryChanges, fileDecorations } from './scm';
	import Icon from './Icon.svelte';
	import { fileIcon, folderIcon } from './fileIcons';
	import { explorer, type Row } from './explorer.svelte';
	import { editors } from './editors.svelte';
	import { baseName, recentLabel, stemLength } from './fileTree';
	import { keyLabel } from './keys';
	import { status } from './status.svelte';
	import { workspace } from './workspace.svelte';

	let { workspaceName }: { workspaceName: string } = $props();

	const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
	const decorations = $derived(fileDecorations(entryChanges(scm.repo?.entries ?? [])));

	let open = $state(true);
	let inputError = $state('');
	let menu = $state<{ x: number; y: number; target: string | null } | null>(null);
	let tree: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (workspace.root && !explorer.children.has('')) explorer.load('');
	});

	type Item = { type: 'row'; row: Row } | { type: 'input'; depth: number; is_dir: boolean; value: string; key: string };

	/** Rows plus VS Code's inline edit box: first in the target folder for New, in place for Rename. */
	const items = $derived.by((): Item[] => {
		const rows = explorer.rows();
		const edit = explorer.editing;
		const out: Item[] = [];
		const input = (depth: number, is_dir: boolean, value: string): Item => ({ type: 'input', depth, is_dir, value, key: `\0input:${edit?.kind === 'rename' ? edit.rel : (edit?.parent ?? '') + edit?.kind}` });
		if (edit && edit.kind !== 'rename' && edit.parent === '') out.push(input(0, edit.kind === 'folder', ''));
		for (const row of rows) {
			if (edit?.kind === 'rename' && edit.rel === row.rel) {
				out.push(input(row.depth, row.is_dir, row.name));
				continue;
			}
			out.push({ type: 'row', row });
			if (edit && edit.kind !== 'rename' && edit.parent === row.rel && row.expanded) out.push(input(row.depth + 1, edit.kind === 'folder', ''));
		}
		return out;
	});

	function select(rel: string | null) {
		explorer.selected = rel;
	}

	/** Mounts the edit box focused, with the name (minus extension) selected like VS Code. */
	function editBox(el: HTMLInputElement, init: { value: string; is_dir: boolean }) {
		inputError = '';
		el.value = init.value;
		queueMicrotask(() => {
			el.focus();
			el.setSelectionRange(0, stemLength(init.value, init.is_dir));
		});
	}

	let committing = false;
	async function commit(el: HTMLInputElement) {
		if (committing || !explorer.editing) return;
		committing = true;
		try {
			// VS Code: an empty New box just goes away.
			if (!el.value.trim() && explorer.editing.kind !== 'rename') {
				explorer.cancelEdit();
				return;
			}
			const err = await explorer.commit(el.value);
			inputError = err ?? '';
			if (!err) tree?.focus();
		} finally {
			committing = false;
		}
	}

	function onInputKey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Enter') {
			e.preventDefault();
			void commit(e.currentTarget as HTMLInputElement);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			explorer.cancelEdit();
			tree?.focus();
		}
	}

	function onInputBlur(e: FocusEvent) {
		// Blur commits a valid name and drops an invalid one, like VS Code.
		const el = e.currentTarget as HTMLInputElement;
		if (!explorer.editing) return;
		void commit(el).then(() => {
			if (inputError) {
				inputError = '';
				explorer.cancelEdit();
			}
		});
	}

	// --- Commands on the selection (VS Code explorer keybindings) -------------------------------

	const absPath = (rel: string) => (rel ? `${workspace.root}/${rel}` : (workspace.root ?? ''));

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch (e) {
			status.error(`คัดลอกไม่ได้: ${e}`);
		}
	}

	function reveal(rel: string | null) {
		invoke('fs_reveal', { rel: rel ?? '' }).catch((e) => status.error(String(e), 8000));
	}

	type MenuItem = { label: string; key?: string; run: () => unknown } | 'sep';

	function menuItems(target: string | null): MenuItem[] {
		const items: MenuItem[] = [
			{ label: 'New File...', run: () => explorer.startCreate('file', target) },
			{ label: 'New Folder...', run: () => explorer.startCreate('folder', target) },
			'sep',
			{ label: isMac ? 'Reveal in Finder' : 'Reveal in File Explorer', key: keyLabel('alt+cmd+r'), run: () => reveal(target) },
			'sep',
			{ label: 'Copy Path', key: keyLabel('alt+cmd+c'), run: () => copy(absPath(target ?? '')) },
			{ label: 'Copy Relative Path', key: keyLabel('alt+shift+cmd+c'), run: () => copy(target ?? '.') }
		];
		if (target) {
			items.push(
				'sep',
				{ label: 'Rename...', key: isMac ? '↵' : 'F2', run: () => explorer.startRename(target) },
				{ label: 'Delete', key: isMac ? '⌘⌫' : 'Delete', run: () => explorer.delete(target) }
			);
		}
		return items;
	}

	function openMenu(e: MouseEvent, target: string | null) {
		e.preventDefault();
		e.stopPropagation();
		select(target);
		// Keep the menu inside the window.
		const x = Math.min(e.clientX, window.innerWidth - 240);
		const y = Math.min(e.clientY, window.innerHeight - 260);
		menu = { x, y, target };
	}

	function onTreeKey(e: KeyboardEvent) {
		const sel = explorer.selected;
		const mod = isMac ? e.metaKey : e.ctrlKey;
		if (e.key === 'F2' || (isMac && e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey)) {
			if (!sel) return;
			explorer.startRename(sel);
		} else if ((isMac && mod && e.key === 'Backspace') || (!isMac && e.key === 'Delete')) {
			if (!sel) return;
			void explorer.delete(sel);
		} else if (mod && e.altKey && e.code === 'KeyC') {
			void copy(e.shiftKey ? (sel ?? '.') : absPath(sel ?? ''));
		} else if (mod && e.altKey && e.code === 'KeyR') {
			reveal(sel);
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const rows = explorer.rows();
			const i = rows.findIndex((r) => r.rel === sel);
			const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
			if (next) {
				select(next.rel);
				tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(next.rel)}"]`)?.focus();
			}
		} else return;
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<svelte:window onkeydown={(e) => menu && e.key === 'Escape' && (menu = null)} onblur={() => (menu = null)} />

{#if !workspace.ready}
	<div></div>
{:else if !workspace.root}
	<!-- VS Code's explorer welcome view (no folder opened). -->
	<section class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-(--kg-row-height) shrink-0 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)">
			<Icon name="chevronDown" size={16} />
			No Folder Opened
		</div>
		<div class="flex flex-col gap-3 px-5 py-2 leading-normal">
			<p>ยังไม่ได้เปิดโฟลเดอร์</p>
			<button
				class="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-[var(--vscode-button-hoverBackground,#026EC1)]"
				onclick={() => workspace.pickFolder()}
			>
				<Icon name="folder" size={15} />Open Folder
			</button>
			{#if workspace.recent.length}
				<div>
					<p class="mb-1 text-[11px] font-medium text-(--vscode-descriptionForeground) uppercase">Recent</p>
					<ul class="-mx-2">
						{#each workspace.recent.slice(0, 5) as path (path)}
							{@const r = recentLabel(path)}
							<li>
								<button class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-(--vscode-list-hoverBackground)" title={path} onclick={() => workspace.openFolder(path)}>
									<span class="shrink-0 text-(--vscode-descriptionForeground)"><Icon name="folder" size={14} /></span>
									<span class="truncate text-(--vscode-textLink-foreground)">{r.label}</span>
									<span class="min-w-0 truncate text-xs text-(--vscode-descriptionForeground)">{r.detail}</span>
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			<p class="text-(--vscode-descriptionForeground)">เปิดโฟลเดอร์ ({keyLabel('cmd+o')}) หรือโฟลเดอร์ล่าสุด ({keyLabel('ctrl+r')})</p>
		</div>
	</section>
{:else}
	<section class="flex min-h-0 flex-1 flex-col">
		<!-- Section header; its actions show on hover or focus, like VS Code's Explorer. -->
		<div class="group flex h-(--kg-row-height) shrink-0 items-center pr-1">
			<button
				class="flex h-full min-w-0 flex-1 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)"
				aria-expanded={open}
				title={workspace.root}
				onclick={() => (open = !open)}
				oncontextmenu={(e) => openMenu(e, null)}
			>
				<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
				<span class="truncate">{workspaceName}</span>
			</button>
			<div class="flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
				{#each [
					{ label: 'New File...', icon: 'newFile', run: () => explorer.startCreate('file') },
					{ label: 'New Folder...', icon: 'newFolder', run: () => explorer.startCreate('folder') },
					{ label: 'Refresh Explorer', icon: 'refresh', run: () => explorer.refresh(['', ...explorer.expanded]) },
					{ label: 'Collapse Folders in Explorer', icon: 'collapseAll', run: () => explorer.collapseAll() }
				] as const as a (a.label)}
					<button
						class="grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
						aria-label={a.label}
						title={a.label}
						onclick={() => {
							open = true;
							void a.run();
						}}><Icon name={a.icon} size={16} /></button
					>
				{/each}
			</div>
		</div>

		{#if open}
			<div
				bind:this={tree}
				role="tree"
				tabindex="-1"
				aria-label="ไฟล์ใน workspace"
				class="min-h-0 flex-1 overflow-y-auto outline-none"
				onkeydown={onTreeKey}
				oncontextmenu={(e) => openMenu(e, null)}
				onclick={(e) => e.target === e.currentTarget && select(null)}
			>
				{#each items as item (item.type === 'row' ? item.row.rel : item.key)}
					{#if item.type === 'input'}
						<div class="relative" style:padding-left="{8 + item.depth * 8}px">
							<div class="flex h-(--kg-row-height) items-center gap-1 pr-2">
								<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)">
									{#if item.is_dir}<Icon name="chevronRight" size={16} />{/if}
								</span>
								<FileIcon icon={item.is_dir ? folderIcon(item.value, false) : fileIcon(item.value)} />
								<input
									use:editBox={{ value: item.value, is_dir: item.is_dir }}
									aria-label={explorer.editing?.kind === 'rename' ? 'ชื่อใหม่' : item.is_dir ? 'ชื่อโฟลเดอร์ใหม่' : 'ชื่อไฟล์ใหม่'}
									aria-invalid={inputError !== ''}
									spellcheck="false"
									class={[
										'h-[20px] min-w-0 flex-1 border bg-(--vscode-input-background) px-1 text-(--vscode-input-foreground) outline-none',
										inputError ? 'border-[color:var(--vscode-inputValidation-errorBorder,#BE1100)]' : 'border-(--vscode-focusBorder)'
									]}
									oninput={() => (inputError = '')}
									onkeydown={onInputKey}
									onblur={onInputBlur}
								/>
							</div>
							{#if inputError}
								<p
									role="alert"
									class="absolute right-2 left-[calc(var(--pad)+20px)] z-10 border border-[color:var(--vscode-inputValidation-errorBorder,#BE1100)] bg-[var(--vscode-inputValidation-errorBackground,#5A1D1D)] px-1 py-0.5 text-xs whitespace-normal"
									style:--pad="{8 + item.depth * 8}px"
								>
									{inputError}
								</p>
							{/if}
						</div>
					{:else}
						{@const row = item.row}
						<button
							role="treeitem"
							data-rel={row.rel}
							aria-selected={explorer.selected === row.rel}
							aria-expanded={row.is_dir ? row.expanded : undefined}
							class={[
								'mx-1.5 flex h-(--kg-row-height) w-[calc(100%-12px)] items-center gap-1 rounded-md pr-2 text-left leading-(--kg-row-height) outline-offset-[-1px]',
								explorer.selected === row.rel
									? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground) outline outline-1 outline-(--vscode-focusBorder)'
									: 'hover:bg-(--vscode-list-hoverBackground)',
								editors.active === row.rel && explorer.selected !== row.rel && 'bg-(--vscode-list-inactiveSelectionBackground)',
								menu?.target === row.rel && 'outline outline-1 outline-(--vscode-focusBorder)'
							]}
							style:padding-left="{8 + row.depth * 8}px"
							title={row.rel}
							onclick={() => {
								select(row.rel);
								if (row.is_dir) explorer.toggle(row.rel);
								else editors.open(row.rel, { preview: true });
							}}
							ondblclick={() => {
								if (!row.is_dir) editors.open(row.rel, { preview: false });
							}}
							oncontextmenu={(e) => openMenu(e, row.rel)}
						>
							<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)">
								{#if row.is_dir}<Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={16} />{/if}
							</span>
							<FileIcon icon={row.is_dir ? folderIcon(row.rel, row.expanded) : fileIcon(row.name)} />
							<span class={['min-w-0 flex-1 truncate', row.ignored && 'italic opacity-55']} style:color={decorations.get(row.rel)?.color}>{row.name}</span>
							{#if row.ignored}<span class="shrink-0 pr-3 pl-2 opacity-55" title="ถูก .gitignore"><Icon name="ignored" size={12} /></span>
							{:else if decorations.has(row.rel)}{@const deco = decorations.get(row.rel)!}<span class="shrink-0 pr-3 pl-2 text-[11px] font-semibold" style:color={deco.color}>{deco.letter || '•'}</span>{/if}
						</button>
					{/if}
				{/each}
				{#if explorer.error}<p class="px-4 py-1 text-(--vscode-errorForeground)">{explorer.error}</p>{/if}
			</div>
		{/if}
	</section>
{/if}

{#if menu}
	{@const m = menu}
	<!-- VS Code's context menu: closes on any click outside, Escape or window blur. -->
	<div
		class="fixed inset-0 z-40"
		role="presentation"
		onpointerdown={() => (menu = null)}
		oncontextmenu={(e) => {
			e.preventDefault();
			menu = null;
		}}
	></div>
	<div
		role="menu"
		aria-label={m.target ? baseName(m.target) : workspaceName}
		class="fixed z-50 min-w-[220px] rounded-md border border-[color:var(--vscode-menu-border,#454545)] bg-[var(--vscode-menu-background,#1F1F1F)] py-1 text-[color:var(--vscode-menu-foreground,#CCCCCC)] shadow-[0_2px_8px_rgba(0,0,0,0.36)]"
		style:left="{m.x}px"
		style:top="{m.y}px"
	>
		{#each menuItems(m.target) as it, i (i)}
			{#if it === 'sep'}
				<div role="separator" class="mx-2 my-1 h-px bg-[var(--vscode-menu-separatorBackground,#454545)]"></div>
			{:else}
				<button
					role="menuitem"
					class="mx-1 flex h-6 w-[calc(100%-8px)] items-center justify-between gap-6 rounded px-3 text-left hover:bg-[var(--vscode-menu-selectionBackground,#0078D4)] hover:text-[color:var(--vscode-menu-selectionForeground,#FFFFFF)]"
					onclick={() => {
						menu = null;
						void it.run();
					}}
				>
					<span>{it.label}</span>
					{#if it.key}<span class="text-xs opacity-80">{it.key}</span>{/if}
				</button>
			{/if}
		{/each}
	</div>
{/if}
