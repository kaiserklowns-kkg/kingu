<script lang="ts">
	// A worktree on an SSH host opened as the folder you work in (sshWorkspace.svelte.ts): the file
	// tree on the left, the open file (saved over ssh with ⌘S) or a change's diff in the middle,
	// Source Control on the right (stage, unstage, commit, push, Create Pull Request). Terminals and
	// the agent CLI open in the floating workspace (sshProjects.terminal).
	import { onMount } from 'svelte';
	import type * as MonacoTypes from 'monaco-editor';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { sshWorkspace as ws } from './sshWorkspace.svelte';
	import { sshProjects } from './sshProjects.svelte';
	import { groupChanges, joinRel, type ChangeRow } from './sshRemote';
	import { cliName } from './agentCli';
	import { adeCommand } from '#lib/agent/launchSpec.ts';

	const MUTED = 'text-(--vscode-descriptionForeground)';
	const ICON_BTN = 'grid size-6 shrink-0 place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:opacity-40';
	const BTN = 'h-7 rounded-md px-2.5 text-[12px] hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const STATUS_DOT: Record<string, string> = { running: 'bg-sky-400 animate-pulse', waiting: 'bg-amber-400', review: 'bg-[#73C991]', failed: 'bg-red-500' };

	const cur = $derived(ws.current);
	const host = $derived(cur ? sshProjects.host(cur.project) : undefined);
	const groups = $derived(groupChanges(ws.git?.changes ?? []));
	const agentName = $derived(cliName(adeCommand(null, (k) => settings.get(k)) ?? ['claude']));
	const agentStatus = $derived(cur ? sshProjects.status(cur.project.host, cur.path) : null);

	let m = $state.raw<typeof import('#lib/editor/monaco.ts') | null>(null);
	let editorHost = $state<HTMLDivElement>();
	let diffHost = $state<HTMLDivElement>();
	let editor: MonacoTypes.editor.IStandaloneCodeEditor | undefined;
	let diffEditor: MonacoTypes.editor.IStandaloneDiffEditor | undefined;
	let model: MonacoTypes.editor.ITextModel | undefined;
	let diffModels: MonacoTypes.editor.ITextModel[] = [];

	onMount(() => {
		let disposed = false;
		import('#lib/editor/monaco.ts').then(async (mod) => {
			await mod.setupTextMate();
			if (!disposed) m = mod;
		});
		return () => {
			disposed = true;
			model?.dispose();
			diffModels.forEach((x) => x.dispose());
			editor?.dispose();
			diffEditor?.dispose();
		};
	});

	const OPTS = { automaticLayout: true, fontFamily: "Menlo, Monaco, 'Courier New', 'IBM Plex Sans Thai', monospace", fontSize: 12, lineHeight: 18, minimap: { enabled: false } } as const;

	// The open file's text model (one at a time; the text lives in the store, so it survives a remount).
	$effect(() => {
		const f = ws.file;
		const ready = m && editorHost && f && !f.loading && !f.error && !f.note;
		if (!ready) return;
		const rel = f.rel;
		if (!editor) {
			editor = m!.monaco.editor.create(editorHost!, { ...OPTS, theme: m!.THEME_ID });
			// ⌘S here saves over ssh (the IDE's own Save never sees the key: data-keybinding-capture).
			editor.addCommand(m!.monaco.KeyMod.CtrlCmd | m!.monaco.KeyCode.KeyS, () => void ws.save());
		}
		if (model && model.uri.path.endsWith(`/${rel}`) && model.getValue() === f.text) return;
		model?.dispose();
		const uri = m!.monaco.Uri.from({ scheme: 'kingu-ssh', authority: 'host', path: `/${cur?.path ?? ''}/${rel}`.replace(/\/+/g, '/') });
		model = m!.monaco.editor.createModel(f.text, m!.languageFor(rel), uri);
		model.onDidChangeContent(() => {
			if (ws.file?.rel === rel && model) ws.file.text = model.getValue();
		});
		editor.setModel(model);
	});

	// A search hit: its line, once the file shows.
	$effect(() => {
		const r = ws.reveal;
		const f = ws.file;
		if (!r || !f || f.rel !== r.rel || f.loading || !editor || !model || !model.uri.path.endsWith(`/${r.rel}`)) return;
		ws.reveal = null;
		editor.revealLineInCenter(r.line);
		editor.setPosition({ lineNumber: r.line, column: 1 });
		editor.focus();
	});

	// The shown change's diff.
	$effect(() => {
		const d = ws.diff;
		if (!m || !diffHost || !d?.data || d.data.binary || d.data.too_large) return;
		if (!diffEditor) diffEditor = m.monaco.editor.createDiffEditor(diffHost, { ...OPTS, theme: m.THEME_ID, readOnly: true, originalEditable: false });
		diffModels.forEach((x) => x.dispose());
		const lang = m.languageFor(d.rel);
		diffModels = [m.monaco.editor.createModel(d.data.original, lang), m.monaco.editor.createModel(d.data.modified, lang)];
		diffEditor.setModel({ original: diffModels[0]!, modified: diffModels[1]! });
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !e.defaultPrevented && !(e.target instanceof Element && e.target.closest('.monaco-editor, textarea, input, [role="dialog"] [role="listbox"]'))) {
			e.preventDefault();
			void ws.close();
		}
	}

	const letterClass = (l: string) => (l === 'D' ? 'text-red-400' : l === 'A' || l === 'U' ? 'text-[#73C991]' : l === '!' ? 'text-amber-400' : 'text-sky-400');
	const base = (p: string) => p.split('/').pop() ?? p;
	const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
</script>

<svelte:window {onkeydown} />

{#snippet tree(rel: string, depth: number)}
	{@const d = ws.dirs[rel]}
	{#if d?.error}<p class="truncate py-0.5 text-[11px] text-(--vscode-errorForeground)" style:padding-left="{depth * 12 + 8}px" title={d.error}>{d.error}</p>{/if}
	{#if !d?.listing && d?.loading}<p class="py-0.5 text-[11px] {MUTED}" style:padding-left="{depth * 12 + 8}px">{t('sshRemote.loading')}</p>{/if}
	{#each d?.listing?.entries ?? [] as e (e.name)}
		{@const child = joinRel(rel, e.name)}
		<button
			class={['flex h-[22px] w-full items-center gap-1 pr-2 text-left text-[12px] hover:bg-(--vscode-list-hoverBackground)', !e.dir && ws.file?.rel === child && 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)']}
			style:padding-left="{depth * 12 + 6}px"
			title={child}
			onclick={() => (e.dir ? ws.toggle(child) : ws.openFile(child))}
		>
			{#if e.dir}
				<span class={['grid size-4 shrink-0 place-items-center transition-transform', !ws.expanded[child] && '-rotate-90']}><Icon name="chevronDown" size={12} /></span>
				<Icon name="folder" size={13} />
			{:else}
				<span class="size-4 shrink-0"></span>
				<Icon name="file" size={13} />
			{/if}
			<span class="truncate">{e.name}</span>
		</button>
		{#if e.dir && ws.expanded[child]}{@render tree(child, depth + 1)}{/if}
	{/each}
	{#if d?.listing?.truncated}<p class="py-0.5 text-[11px] {MUTED}" style:padding-left="{depth * 12 + 8}px">{t('sshRemote.truncated')}</p>{/if}
{/snippet}

{#snippet changeRow(r: ChangeRow)}
	<div class={['group/row flex h-[22px] items-center gap-1 rounded pr-1 pl-2 hover:bg-(--vscode-list-hoverBackground)', ws.diff?.rel === r.path && ws.diff.staged === r.staged && 'bg-(--vscode-list-inactiveSelectionBackground)']}>
		<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]" title={r.orig ? `${r.orig} → ${r.path}` : r.path} onclick={() => ws.showDiff(r)}>
			<span class="truncate">{base(r.path)}</span>
			<span class="truncate text-[11px] {MUTED}">{dirOf(r.path)}</span>
		</button>
		{#if !r.staged}<button class="{ICON_BTN} opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" title={t('sshRemote.discardOne')} aria-label={t('sshRemote.discardOne')} disabled={!!ws.busy} onclick={() => ws.discard([r])}><Icon name="discard" size={12} /></button>{/if}
		<button class="{ICON_BTN} opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" title={r.staged ? t('sshRemote.unstage') : t('sshRemote.stage')} aria-label={r.staged ? t('sshRemote.unstage') : t('sshRemote.stage')} disabled={!!ws.busy} onclick={() => ws.stage([r], !r.staged)}><Icon name={r.staged ? 'minus' : 'plus'} size={12} /></button>
		<span class="w-3 shrink-0 text-center font-mono text-[11px] {letterClass(r.letter)}">{r.letter}</span>
	</div>
{/snippet}

{#if cur}
	<div class="fixed inset-0 z-[44] flex flex-col bg-(--vscode-editor-background) text-(--vscode-foreground)" role="dialog" aria-modal="true" aria-label={ws.label(host?.label ?? cur.project.host)}>
		<header class="flex h-10 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3">
			<span class="grid size-5 place-items-center rounded-[4px] bg-emerald-500/15 text-emerald-400"><Icon name="desktop" size={12} /></span>
			<span class="truncate text-[13px] font-semibold" title={`${host?.label ?? cur.project.host}:${cur.path}`}>{ws.label(host?.label ?? cur.project.host)}</span>
			{#if ws.git?.branch}<span class="truncate font-mono text-[11px] {MUTED}"><Icon name="git" size={11} /> {ws.git.branch}{ws.git.ahead ? ` ↑${ws.git.ahead}` : ''}{ws.git.behind ? ` ↓${ws.git.behind}` : ''}</span>{/if}
			{#if agentStatus}
				<span class="flex items-center gap-1 text-[11px] {MUTED}"><span class="size-2 rounded-full {STATUS_DOT[agentStatus] ?? ''}"></span>{t(`sshRemote.agent.${agentStatus}`)}</span>
			{/if}
			<span class="flex-1"></span>
			<button class={BTN} onclick={() => sshProjects.terminal(cur.project, cur.path)}><Icon name="terminal" size={12} /> {t('adeProjects.sshTerminal')}</button>
			<button class={BTN} onclick={() => sshProjects.terminal(cur.project, cur.path, true)}><Icon name="agent" size={12} /> {t('adeProjects.sshAgent', { agent: agentName })}</button>
			<button class={ICON_BTN} title={t('sshRemote.goToFile')} aria-label={t('sshRemote.goToFile')} onclick={() => ws.quickOpen()}><Icon name="goToFile" size={13} /></button>
			<button class={ICON_BTN} title={t('sshRemote.searchPlaceholder')} aria-label={t('sshRemote.searchPlaceholder')} onclick={() => ws.search()}><Icon name="search" size={13} /></button>
			<button class={ICON_BTN} title={t('sshRemote.refresh')} aria-label={t('sshRemote.refresh')} onclick={() => (ws.list(''), ws.refreshGit())}><Icon name="refresh" size={13} /></button>
			<button class={ICON_BTN} title={t('sshRemote.close')} aria-label={t('sshRemote.close')} onclick={() => ws.close()}><Icon name="close" size={14} /></button>
		</header>
		<div class="flex min-h-0 flex-1">
			<nav class="w-64 shrink-0 overflow-y-auto border-r border-(--vscode-widget-border) py-1" aria-label={t('sshRemote.files')}>
				{@render tree('', 0)}
			</nav>
			<main class="flex min-w-0 flex-1 flex-col">
				{#if ws.file}
					<div class="flex h-8 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3 text-[12px]">
						<Icon name="file" size={12} />
						<span class="truncate">{ws.file.rel}</span>
						{#if ws.dirty}<span class="size-2 rounded-full bg-(--vscode-foreground)/70" title={t('sshRemote.unsaved')}></span>{/if}
						<span class="flex-1"></span>
						<button class={BTN} disabled={!ws.dirty || ws.file.saving} onclick={() => ws.save()}>{ws.file.saving ? t('sshRemote.saving') : t('sshRemote.save')}</button>
					</div>
					{#if ws.file.loading}<p class="p-4 text-[12px] {MUTED}">{t('sshRemote.loading')}</p>
					{:else if ws.file.error}<p class="p-4 text-[12px] text-(--vscode-errorForeground)">{ws.file.error}</p>
					{:else if ws.file.note}<p class="p-4 text-[12px] {MUTED}">{ws.file.note}</p>{/if}
				{:else if ws.diff}
					<div class="flex h-8 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3 text-[12px]">
						<Icon name="git" size={12} />
						<span class="truncate">{ws.diff.rel}</span>
						<span class={MUTED}>{ws.diff.staged ? t('sshRemote.diffStaged') : t('sshRemote.diffWorking')}</span>
						<span class="flex-1"></span>
						<button class={BTN} onclick={() => ws.diff && ws.openFile(ws.diff.rel)}>{t('sshRemote.openFile')}</button>
					</div>
					{#if ws.diff.error}<p class="p-4 text-[12px] text-(--vscode-errorForeground)">{ws.diff.error}</p>
					{:else if !ws.diff.data}<p class="p-4 text-[12px] {MUTED}">{t('sshRemote.loading')}</p>
					{:else if ws.diff.data.binary}<p class="p-4 text-[12px] {MUTED}">{t('sshRemote.binary')}</p>
					{:else if ws.diff.data.too_large}<p class="p-4 text-[12px] {MUTED}">{t('sshRemote.tooLarge')}</p>{/if}
				{:else}
					<p class="m-auto max-w-sm p-6 text-center text-[12px] {MUTED}">{t('sshRemote.empty')}</p>
				{/if}
				<div class={['min-h-0 flex-1', !(ws.file && !ws.file.loading && !ws.file.error && !ws.file.note) && 'hidden']} bind:this={editorHost} data-keybinding-capture></div>
				<div class={['min-h-0 flex-1', !(ws.diff?.data && !ws.diff.data.binary && !ws.diff.data.too_large && !ws.file) && 'hidden']} bind:this={diffHost}></div>
			</main>
			<aside class="flex w-72 shrink-0 flex-col border-l border-(--vscode-widget-border)" aria-label={t('sshRemote.scm')}>
				<div class="flex h-8 shrink-0 items-center gap-1 px-3">
					<span class="flex-1 text-[11px] font-semibold tracking-wide uppercase {MUTED}">{t('sshRemote.scm')}</span>
					<button class={ICON_BTN} title={t('sshRemote.fetch')} aria-label={t('sshRemote.fetch')} disabled={!!ws.busy} onclick={() => ws.sync(false)}><Icon name="sync" size={13} /></button>
					<button class={ICON_BTN} title={t('sshRemote.pull')} aria-label={t('sshRemote.pull')} disabled={!!ws.busy} onclick={() => ws.sync(true)}><Icon name="arrowDown" size={13} /></button>
					<button class={ICON_BTN} title={t('sshRemote.push')} aria-label={t('sshRemote.push')} disabled={!!ws.busy} onclick={() => ws.push()}><Icon name="arrowUp" size={13} /></button>
					<button class={ICON_BTN} title={t('sshRemote.createPr')} aria-label={t('sshRemote.createPr')} disabled={!!ws.busy || !ws.git?.branch} onclick={() => ws.createPr()}><Icon name="pullRequest" size={13} /></button>
					<button class={ICON_BTN} title={t('sshRemote.refresh')} aria-label={t('sshRemote.refresh')} onclick={() => ws.refreshGit()}><Icon name="refresh" size={12} /></button>
				</div>
				<div class="px-3 pb-2">
					<textarea class="h-16 w-full resize-none rounded border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) p-1.5 text-[12px] outline-none focus:border-(--vscode-focusBorder)" placeholder={t('sshRemote.messagePlaceholder')} bind:value={ws.message} onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), ws.commit())}></textarea>
					<button class="mt-1 h-7 w-full rounded-md bg-(--vscode-button-background) text-[12px] text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-40" disabled={!!ws.busy || !groups.staged.length || !ws.message.trim()} onclick={() => ws.commit()}>
						{ws.busy ? t(`sshRemote.busy.${ws.busy}`) : t('sshRemote.commit')}
					</button>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
					{#if ws.gitError}<p class="px-2 text-[11px] text-(--vscode-errorForeground)" title={ws.gitError}>{ws.gitError}</p>{/if}
					{#if !ws.git && ws.gitLoading}<p class="px-2 text-[11px] {MUTED}">{t('sshRemote.loading')}</p>{/if}
					{#if groups.staged.length}
						<div class="flex h-6 items-center px-2 text-[11px] font-semibold {MUTED}">
							<span class="flex-1">{t('sshRemote.staged')} ({groups.staged.length})</span>
							<button class={ICON_BTN} title={t('sshRemote.unstageAll')} aria-label={t('sshRemote.unstageAll')} disabled={!!ws.busy} onclick={() => ws.stage(groups.staged, false)}><Icon name="minus" size={12} /></button>
						</div>
						{#each groups.staged as r (`s${r.path}`)}{@render changeRow(r)}{/each}
					{/if}
					<div class="flex h-6 items-center px-2 text-[11px] font-semibold {MUTED}">
						<span class="flex-1">{t('sshRemote.changes')} ({groups.unstaged.length})</span>
						{#if groups.unstaged.length}<button class={ICON_BTN} title={t('sshRemote.discardAll')} aria-label={t('sshRemote.discardAll')} disabled={!!ws.busy} onclick={() => ws.discard(groups.unstaged)}><Icon name="discard" size={12} /></button>{/if}
						{#if groups.unstaged.length}<button class={ICON_BTN} title={t('sshRemote.stageAll')} aria-label={t('sshRemote.stageAll')} disabled={!!ws.busy} onclick={() => ws.stage(groups.unstaged, true)}><Icon name="plus" size={12} /></button>{/if}
					</div>
					{#each groups.unstaged as r (`u${r.path}`)}{@render changeRow(r)}{/each}
					{#if ws.git && !ws.git.changes.length}<p class="px-2 text-[11px] {MUTED}">{t('sshRemote.noChanges')}</p>{/if}
				</div>
			</aside>
		</div>
	</div>
{/if}
