<script lang="ts">
	// VS Code's Search view (searchView.ts / searchWidget.ts): query box with Match Case,
	// Whole Word and Regex toggles, the Replace box behind the chevron (Preserve Case, Replace
	// All, per-file and per-match replace on hover), include/exclude globs behind "…", and a
	// results tree.
	// The tree is virtualized at the 22px row height, so 20,000 matches stay cheap.
	import FileIcon from './FileIcon.svelte';
	import Icon from './Icon.svelte';
	import { fileIcon, folderIcon } from './fileIcons';
	import { editors } from './editors.svelte';
	import { search } from './search.svelte';
	import {
		basename,
		dirname,
		flattenResults,
		previewReplacement,
		replaceConfirmText,
		sortResults,
		splitPreview,
		summarize,
		type FileMatches,
		type ResultRow,
		type ResultSortOrder
	} from './searchResults';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { scm } from './scm.svelte';
	import { entryChanges, fileDecorations } from './scm';

	const ROW = 22;
	const OVERSCAN = 10;

	let input: HTMLInputElement | undefined = $state();
	let tree: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewHeight = $state(0);
	let selected = $state(-1);
	let confirmAll = $state(false);

	// search.sortOrder and the List / Tree view mode (search.defaultViewMode).
	const rows = $derived(flattenResults(sortResults(search.files, settings.get<ResultSortOrder>('search.sortOrder')), search.collapsed, search.viewMode));
	/** search.showLineNumbers, search.decorations.colors / search.decorations.badges. */
	const lineNumbers = $derived(settings.get<boolean>('search.showLineNumbers'));
	const decoColors = $derived(settings.get<boolean>('search.decorations.colors'));
	const decoBadges = $derived(settings.get<boolean>('search.decorations.badges'));
	const decorations = $derived(decoColors || decoBadges ? fileDecorations(entryChanges(scm.repo?.entries ?? [])) : new Map());
	const PAD = 8;
	const INDENT = 20;
	const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
	const visible = $derived(rows.slice(first, first + Math.ceil(viewHeight / ROW) + 2 * OVERSCAN));
	const shownMatches = $derived(search.files.reduce((n, f) => n + f.matches.length, 0));
	const canReplace = $derived(search.showReplace && search.searched !== null && !search.replacing);

	/** Replace All asks first, with counts (VS Code's confirmation dialog). */
	function askReplaceAll() {
		if (canReplace && shownMatches && !search.running) confirmAll = true;
	}

	function replaceAll() {
		confirmAll = false;
		void search.replace(search.files);
	}

	function replaceRow(row: Exclude<ResultRow, { kind: 'folder' }>, e: MouseEvent) {
		e.stopPropagation();
		const scope: FileMatches[] = row.kind === 'file' ? [row.file] : [{ ...row.file, matches: [row.match] }];
		void search.replace(scope);
	}

	function onReplaceKey(e: KeyboardEvent) {
		// VS Code: ⌥⌘Enter (and Enter in the Replace box) replaces all.
		if (e.key === 'Enter') askReplaceAll();
		else if (e.key === 'Escape' && confirmAll) confirmAll = false;
		else return;
		e.preventDefault();
	}

	const replacementOf = (text: string) =>
		search.searched ? previewReplacement(text, search.replaceText, { isRegex: search.searched.is_regex, matchCase: search.searched.match_case, query: search.searched.query }) : search.replaceText;

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
		if (row.kind === 'folder') {
			search.toggleCollapsed(row.key);
			return;
		}
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
			if (row.kind !== 'match' && !row.collapsed) search.toggleCollapsed(row.key);
			else if (row.kind === 'match') select(rows.findIndex((r) => r.kind === 'file' && r.file === row.file));
		} else if (e.key === 'ArrowRight' && row && row.kind !== 'match' && row.collapsed) search.toggleCollapsed(row.key);
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
	<div class="flex shrink-0 flex-col gap-1 pr-3 pl-0.5">
		<div class="flex gap-0.5">
			<button
				class="flex w-4 shrink-0 items-start justify-center rounded-[3px] pt-[5px] text-(--vscode-icon-foreground) hover:bg-(--vscode-list-hoverBackground)"
				title="Toggle Replace"
				aria-label="Toggle Replace"
				aria-expanded={search.showReplace}
				onclick={() => {
					search.showReplace = !search.showReplace;
					confirmAll = false;
				}}><Icon name={search.showReplace ? 'chevronDown' : 'chevronRight'} size={16} /></button
			>
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<div class={inputBox}>
					<input
						bind:this={input}
						bind:value={search.query}
						oninput={() => search.schedule()}
						onkeydown={onInputKey}
						onfocus={() => search.seedOnFocus(editors.selectionText(settings.get<boolean>('search.seedWithNearestWord')))}
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

				{#if search.showReplace}
					<div class="flex items-center gap-0.5">
						<div class={[inputBox, 'min-w-0 flex-1']}>
							<input
								bind:value={search.replaceText}
								onkeydown={onReplaceKey}
								aria-label="Replace"
								placeholder="Replace"
								spellcheck="false"
								class={inputField}
							/>
							<div class="flex shrink-0 pr-0.5">
								<button
									class={toggleClass(search.preserveCase)}
									title="Preserve Case (⌥⌘P)"
									aria-label="Preserve Case"
									aria-pressed={search.preserveCase}
									onclick={() => (search.preserveCase = !search.preserveCase)}><span class="text-[11px]">AB</span></button
								>
							</div>
						</div>
						<button
							class="flex h-[26px] w-6 shrink-0 items-center justify-center rounded-[3px] text-(--vscode-icon-foreground) hover:bg-(--vscode-list-hoverBackground) disabled:opacity-40"
							title="Replace All (⌥⌘Enter)"
							aria-label="Replace All"
							disabled={!canReplace || !shownMatches || search.running}
							onclick={askReplaceAll}><Icon name="replaceAll" size={16} /></button
						>
					</div>
				{/if}
			</div>
		</div>

		{#if confirmAll}
			<div role="alertdialog" aria-label="Confirm Replace All" class="ml-[18px] flex flex-col gap-1.5 rounded border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-2">
				<p>{replaceConfirmText(shownMatches, search.files.length, search.replaceText)}</p>
				<div class="flex justify-end gap-1.5">
					<button class="rounded-sm px-2 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (confirmAll = false)}>Cancel</button>
					<!-- svelte-ignore a11y_autofocus -->
					<button autofocus class="rounded-sm bg-(--vscode-button-background) px-2 py-0.5 text-(--vscode-button-foreground) hover:brightness-110" onclick={replaceAll}
						>Replace</button
					>
				</div>
			</div>
		{/if}

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
			<label class="ml-[18px] flex flex-col gap-0.5">
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
			<label class="ml-[18px] flex flex-col gap-0.5">
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
		{#if search.query}
			<div class="ml-auto flex shrink-0 items-center">
				{#each [
					{ label: 'Refresh', icon: 'refresh', run: () => void search.run(), show: true },
					{ label: 'Clear Search Results', icon: 'close', run: () => search.clear(), show: true },
					{ label: 'Collapse All', icon: 'collapseAll', run: () => search.collapseAll(), show: search.files.length > 0 },
					{
						label: search.viewMode === 'tree' ? 'View as List' : 'View as Tree',
						icon: search.viewMode === 'tree' ? 'rows' : 'folder',
						run: () => (search.viewMode = search.viewMode === 'tree' ? 'list' : 'tree'),
						show: true
					}
				] as const as a (a.label)}
					{#if a.show}
						<button
							class="grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
							title={a.label}
							aria-label={a.label}
							onclick={a.run}><Icon name={a.icon} size={15} /></button
						>
					{/if}
				{/each}
			</div>
		{/if}
	</div>

	<div
		bind:this={tree}
		bind:clientHeight={viewHeight}
		role="tree"
		aria-label="Search results"
		tabindex="0"
		class="relative mt-1 min-h-0 flex-1 overflow-y-auto outline-none"
		style:scroll-behavior="var(--kg-list-scroll-behavior, auto)"
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
					aria-expanded={row.kind !== 'match' ? !row.collapsed : undefined}
					aria-level={row.depth + 1}
					class={[
						'group/row flex h-(--kg-row-height) cursor-pointer items-center gap-1 pr-3 leading-(--kg-row-height) whitespace-nowrap',
						selected === i
							? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)'
							: 'hover:bg-(--vscode-list-hoverBackground)'
					]}
					style:padding-left="{PAD + row.depth * INDENT}px"
					onclick={() => {
						selected = i;
						open(row, false);
						tree?.focus();
					}}
					ondblclick={() => row.kind === 'match' && open(row, true)}
				>
					{#if row.kind === 'folder'}
						<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)"><Icon name={row.collapsed ? 'chevronRight' : 'chevronDown'} size={16} /></span>
						<span class="flex w-4 shrink-0 justify-center"><FileIcon icon={folderIcon(row.path, !row.collapsed)} /></span>
						<span class="min-w-0 truncate" title={row.path}>{basename(row.path)}</span>
					{:else if row.kind === 'file'}
						{@const deco = decorations.get(row.file.path)}
						<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)"><Icon name={row.collapsed ? 'chevronRight' : 'chevronDown'} size={16} /></span>
						<span class="flex w-4 shrink-0 justify-center"><FileIcon icon={fileIcon(row.file.path)} /></span>
						<span class="min-w-0 truncate" title={row.file.path}>
							<span style:color={decoColors ? deco?.color : undefined}>{basename(row.file.path)}</span>{#if search.viewMode === 'list'}<span class="ml-1.5 text-[0.9em] text-(--vscode-descriptionForeground)">{dirname(row.file.path)}</span>{/if}
						</span>
						{#if decoBadges && deco}<span class="shrink-0 text-[11px] font-semibold" style:color={decoColors ? deco.color : undefined}>{deco.letter || '•'}</span>{/if}
						{#if canReplace}
							<button
								class="ml-auto hidden size-5 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) group-hover/row:grid hover:bg-(--vscode-toolbar-hoverBackground)"
								title="Replace All in File"
								aria-label="Replace All in {basename(row.file.path)}"
								onclick={(e) => replaceRow(row, e)}><Icon name="replaceAll" size={14} /></button
							>
						{/if}
						<span
							class={[
								'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[11px] bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)',
								canReplace ? 'ml-auto group-hover/row:ml-0' : 'ml-auto'
							]}>{row.file.matches.length}</span
						>
					{:else}
						{@const p = splitPreview(row.match)}
						{#if lineNumbers}<span class="shrink-0 text-(--vscode-descriptionForeground)">{row.match.line}</span>{/if}
						{#if search.showReplace}
							<span class="min-w-0 truncate" title="{row.match.line}: {row.match.preview}"
								>{p.before}<span class="bg-[var(--vscode-diffEditor-removedTextBackground,#FF000033)] line-through">{p.match}</span><span
									class="bg-[var(--vscode-diffEditor-insertedTextBackground,#9CCC2C33)]">{replacementOf(row.match.text)}</span
								>{p.after}</span
							>
							{#if canReplace}
								<button
									class="ml-auto hidden size-5 shrink-0 place-items-center rounded text-(--vscode-icon-foreground) group-hover/row:grid hover:bg-(--vscode-toolbar-hoverBackground)"
									title="Replace"
									aria-label="Replace"
									onclick={(e) => replaceRow(row, e)}><Icon name="replace" size={14} /></button
								>
							{/if}
						{:else}
							<span class="min-w-0 truncate" title="{row.match.line}: {row.match.preview}"
								>{p.before}<span
									class="rounded-[2px] bg-[var(--vscode-editor-findMatchHighlightBackground,#EA5C0055)]"
									>{p.match}</span
								>{p.after}</span
							>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
	</div>
</section>
