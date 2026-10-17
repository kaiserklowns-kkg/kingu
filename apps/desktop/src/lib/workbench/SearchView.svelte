<script lang="ts">
	// VS Code's Search view (searchView.ts / searchWidget.ts): query box with Match Case,
	// Whole Word and Regex toggles, include/exclude globs behind "…", and a results tree.
	// The tree is virtualized at the 22px row height, so 20,000 matches stay cheap.
	import Icon from './Icon.svelte';
	import { editors } from './editors.svelte';
	import { search } from './search.svelte';
	import { basename, dirname, flattenResults, splitPreview, summarize, type ResultRow } from './searchResults';

	const ROW = 22;
	const OVERSCAN = 10;

	let input: HTMLInputElement | undefined = $state();
	let tree: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewHeight = $state(0);
	let selected = $state(-1);

	const rows = $derived(flattenResults(search.files, search.collapsed));
	const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
	const visible = $derived(rows.slice(first, first + Math.ceil(viewHeight / ROW) + 2 * OVERSCAN));
	const shownMatches = $derived(search.files.reduce((n, f) => n + f.matches.length, 0));

	$effect(() => {
		if (search.focusRequested && input) {
			search.focusRequested = false;
			input.focus();
			input.select();
		}
	});

	// A new result set resets the selection.
	$effect(() => {
		void search.files;
		if (selected >= rows.length) selected = -1;
	});

	function open(row: ResultRow, pin: boolean) {
		if (row.kind === 'file') {
			search.toggleCollapsed(row.file.path);
			return;
		}
		const { line, column, end_column } = row.match;
		editors.open(row.file.path, { preview: !pin, reveal: { line, column, endColumn: end_column, focus: pin } });
	}

	function scrollIntoView(i: number) {
		if (!tree) return;
		const top = i * ROW;
		if (top < tree.scrollTop) tree.scrollTop = top;
		else if (top + ROW > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + ROW - tree.clientHeight;
	}

	function select(i: number) {
		selected = Math.max(0, Math.min(rows.length - 1, i));
		scrollIntoView(selected);
	}

	function onTreeKey(e: KeyboardEvent) {
		const row = rows[selected];
		if (e.key === 'ArrowDown') select(selected + 1);
		else if (e.key === 'ArrowUp') {
			if (selected <= 0) input?.focus();
			else select(selected - 1);
		} else if (e.key === 'Enter' && row) open(row, false);
		else if (e.key === 'ArrowLeft' && row) {
			if (row.kind === 'file' && !row.collapsed) search.toggleCollapsed(row.file.path);
			else if (row.kind === 'match') select(rows.findIndex((r) => r.kind === 'file' && r.file === row.file));
		} else if (e.key === 'ArrowRight' && row?.kind === 'file' && row.collapsed) search.toggleCollapsed(row.file.path);
		else return;
		e.preventDefault();
	}

	function onInputKey(e: KeyboardEvent) {
		if (e.key === 'Enter') void search.run();
		else if (e.key === 'Escape' && search.query) search.clear();
		else if (e.key === 'ArrowDown' && rows.length) {
			tree?.focus();
			select(selected < 0 ? 0 : selected);
		} else return;
		e.preventDefault();
	}

	const toggles = [
		{ key: 'matchCase', label: 'Aa', title: 'Match Case (⌥⌘C)' },
		{ key: 'wholeWord', label: 'ab', title: 'Match Whole Word (⌥⌘W)' },
		{ key: 'isRegex', label: '.*', title: 'Use Regular Expression (⌥⌘R)' }
	] as const;

	const toggleClass = (on: boolean) => [
		'flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border font-mono text-[12px] leading-none',
		on
			? 'border-[var(--vscode-inputOption-activeBorder,#2488DB)] bg-[var(--vscode-inputOption-activeBackground,#2489DB82)] text-[var(--vscode-inputOption-activeForeground,#FFFFFF)]'
			: 'border-transparent text-(--vscode-icon-foreground) hover:bg-[var(--vscode-inputOption-hoverBackground,#5A5D5E80)]'
	];
	const inputBox =
		'flex h-[26px] items-center rounded-[2px] border border-(--vscode-input-border) bg-(--vscode-input-background) text-(--vscode-input-foreground) focus-within:border-(--vscode-focusBorder)';
	const inputField = 'h-full min-w-0 flex-1 bg-transparent px-1.5 outline-none placeholder:text-(--vscode-input-placeholderForeground)';
</script>

<section aria-label="Search" class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 flex-col gap-1 pr-3 pl-3">
		<div class={inputBox}>
			<input
				bind:this={input}
				bind:value={search.query}
				oninput={() => search.schedule()}
				onkeydown={onInputKey}
				aria-label="Search"
				placeholder="Search"
				spellcheck="false"
				class={inputField}
			/>
			<div class="flex shrink-0 gap-0.5 pr-0.5">
				{#each toggles as t (t.key)}
					<button
						class={toggleClass(search[t.key])}
						title={t.title}
						aria-label={t.title}
						aria-pressed={search[t.key]}
						onclick={() => {
							search[t.key] = !search[t.key];
							void search.run();
						}}
					>
						<span class={t.key === 'wholeWord' ? 'underline decoration-1 underline-offset-2' : undefined}>{t.label}</span>
					</button>
				{/each}
			</div>
		</div>

		<div class="flex justify-end">
			<button
				class="h-4 rounded-[3px] px-1 text-[13px] leading-none tracking-widest text-(--vscode-icon-foreground) hover:bg-(--vscode-list-hoverBackground)"
				title="Toggle Search Details"
				aria-label="Toggle Search Details"
				aria-expanded={search.showDetails}
				onclick={() => (search.showDetails = !search.showDetails)}>…</button
			>
		</div>

		{#if search.showDetails}
			<label class="flex flex-col gap-0.5">
				<span class="text-[11px]">files to include</span>
				<div class={inputBox}>
					<input
						bind:value={search.include}
						oninput={() => search.schedule()}
						onkeydown={(e) => e.key === 'Enter' && search.run()}
						placeholder="e.g. *.ts, src/**/include"
						spellcheck="false"
						class={inputField}
					/>
				</div>
			</label>
			<label class="flex flex-col gap-0.5">
				<span class="text-[11px]">files to exclude</span>
				<div class={inputBox}>
					<input
						bind:value={search.exclude}
						oninput={() => search.schedule()}
						onkeydown={(e) => e.key === 'Enter' && search.run()}
						placeholder="e.g. *.ts, src/**/exclude"
						spellcheck="false"
						class={inputField}
					/>
					<button
						class={[toggleClass(search.useIgnoreFiles), 'mr-0.5']}
						title="Use Exclude Settings and Ignore Files (.gitignore)"
						aria-label="Use Exclude Settings and Ignore Files"
						aria-pressed={search.useIgnoreFiles}
						onclick={() => {
							search.useIgnoreFiles = !search.useIgnoreFiles;
							void search.run();
						}}
					>
						<Icon name="file" size={14} />
					</button>
				</div>
			</label>
		{/if}
	</div>

	<div class="flex min-h-[22px] shrink-0 items-center gap-2 px-3 pt-1 text-(--vscode-descriptionForeground)" aria-live="polite">
		{#if search.error}
			<span class="text-(--vscode-errorForeground) whitespace-pre-wrap">{search.error}</span>
		{:else if search.done}
			<span class="truncate">
				{search.done.matches === 0 ? 'ไม่พบผลลัพธ์ ลองปรับตัวเลือกหรือไฟล์ที่ exclude' : summarize(search.done.matches, search.done.files)}
				{#if search.done.limitHit}· ผลลัพธ์ถูกตัดที่ {search.done.matches.toLocaleString()} รายการ{/if}
			</span>
		{:else if search.running}
			<span>กำลังค้นหา… {shownMatches ? summarize(shownMatches, search.files.length) : ''}</span>
		{/if}
		{#if search.files.length}
			<button class="ml-auto shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={() => search.collapseAll()}>Collapse All</button>
		{/if}
	</div>

	<div
		bind:this={tree}
		bind:clientHeight={viewHeight}
		role="tree"
		aria-label="Search results"
		tabindex="0"
		class="relative mt-1 min-h-0 flex-1 overflow-y-auto outline-none"
		onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
		onkeydown={onTreeKey}
	>
		<div style:height="{rows.length * ROW}px"></div>
		<div class="absolute inset-x-0 top-0" style:transform="translateY({first * ROW}px)">
			{#each visible as row, k (row.key)}
				{@const i = first + k}
				<!-- svelte-ignore a11y_click_events_have_key_events (keyboard is handled on the tree) -->
				<div
					role="treeitem"
					tabindex="-1"
					aria-selected={selected === i}
					aria-expanded={row.kind === 'file' ? !row.collapsed : undefined}
					aria-level={row.kind === 'file' ? 1 : 2}
					class={[
						'flex h-(--kg-row-height) cursor-pointer items-center gap-1 pr-3 leading-(--kg-row-height) whitespace-nowrap',
						selected === i
							? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)'
							: 'hover:bg-(--vscode-list-hoverBackground)'
					]}
					style:padding-left={row.kind === 'file' ? '8px' : '28px'}
					onclick={() => {
						selected = i;
						open(row, false);
						tree?.focus();
					}}
					ondblclick={() => row.kind === 'match' && open(row, true)}
				>
					{#if row.kind === 'file'}
						<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)"><Icon name={row.collapsed ? 'chevronRight' : 'chevronDown'} size={16} /></span>
						<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)"><Icon name="file" size={14} /></span>
						<span class="min-w-0 truncate" title={row.file.path}>
							{basename(row.file.path)}<span class="ml-1.5 text-[0.9em] text-(--vscode-descriptionForeground)">{dirname(row.file.path)}</span>
						</span>
						<span
							class="ml-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[11px] bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)"
							>{row.file.matches.length}</span
						>
					{:else}
						{@const p = splitPreview(row.match)}
						<span class="min-w-0 truncate" title="{row.match.line}: {row.match.preview}"
							>{p.before}<span
								class="rounded-[2px] bg-[var(--vscode-editor-findMatchHighlightBackground,#EA5C0055)]"
								>{p.match}</span
							>{p.after}</span
						>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</section>
