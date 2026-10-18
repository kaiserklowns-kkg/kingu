<script lang="ts">
	// Agent panel (secondary side bar), laid out like VS Code's Chat view: a session switcher on
	// top, the selected session's timeline, and the composer pinned to the bottom.
	// Sessions are this folder's chats (`chats`: an agent-host session in the folder or a task's
	// worktree, no worktree of its own, persisted with its transcript) and its ADE tasks. Timeline
	// tasks keep their follow-up composer (through `adeTasks`); terminal tasks are read-only rows
	// with "Open in Agents": a hand-off only, which never sends and never clears a draft. The chat
	// never types into a terminal and never starts a CLI.
	import { untrack } from 'svelte';
	import type { Attachment } from './attachments.ts';
	import AgentTimeline from './AgentTimeline.svelte';
	import Composer from './Composer.svelte';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { runtime } from '#lib/ade/runtime.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { t } from '#lib/i18n/index.ts';
	import { STATUS_LABEL, type RunStatus } from './events';
	import { cliOf } from '#lib/ade/agentCli.ts';
	import { openAgents } from '#lib/ade/agentsMode.svelte.ts';
	import CliQuestion from '#lib/ade/CliQuestion.svelte';
	import { chats } from './chats.svelte.ts';
	import { PERMISSION_MODES, sessionRows, type ChatCwd, type PermissionMode } from './chats.ts';

	type Selection = { kind: 'chat'; id: string } | { kind: 'task'; slug: string } | null;

	let selected = $state<Selection>(null);
	let composingNew = $state(false);
	let showList = $state(false);
	let busy = $state(false);
	let draft = $state('');
	let draftFiles = $state<Attachment[]>([]);
	let followUp = $state('');
	let followUpFiles = $state<Attachment[]>([]);
	let renaming = $state(false);
	let renameText = $state('');
	/** New chat picks: where it runs ('' = this folder, else a task slug), model, permission mode. */
	let newWhere = $state('');
	let newModel = $state(chats.defaults().model ?? '');
	let newMode = $state<PermissionMode>(chats.defaults().permissionMode);
	/** Where the last model / mode change took effect, shown under the composer. */
	let optionNote = $state('');

	const chatMeta = $derived(selected?.kind === 'chat' ? chats.get(selected.id) : undefined);
	const chatRun = $derived(selected?.kind === 'chat' ? chats.run(selected.id) : undefined);
	const taskMeta = $derived(selected?.kind === 'task' ? adeTasks.list.find((x) => x.slug === (selected as { slug: string }).slug) : undefined);
	const taskRun = $derived(taskMeta ? runtime.run(taskMeta.slug) : undefined);
	const taskRt = $derived(taskMeta ? runtime.get(taskMeta.slug) : undefined);
	const terminalTask = $derived(!!taskMeta && !!cliOf(taskMeta.agent));
	const rows = $derived(
		sessionRows(
			chats.list,
			adeTasks.list.map((x) => ({ slug: x.slug, title: x.title, created_at: x.created_at, updated_at: x.updated_at, terminal: !!cliOf(x.agent) }))
		)
	);
	const chatLive = $derived(!!chatRun && !chatRun.ended);
	const chatWorking = $derived(chatLive && chatRun?.status !== 'idle');
	const taskWorktrees = $derived(adeTasks.worktrees.filter((w) => w.slug).map((w) => w.slug as string));

	// A different folder: its chats, nothing selected.
	$effect(() => {
		void workspace.root;
		untrack(() => {
			selected = null;
			composingNew = false;
			showList = false;
			void chats.load();
		});
	});

	// Drop a removed session; with nothing selected, show the newest one (or the new chat composer).
	$effect(() => {
		if (selected?.kind === 'chat' && chats.loaded && !chats.get(selected.id)) selected = null;
		if (selected?.kind === 'task' && adeTasks.loaded && !adeTasks.list.some((x) => x.slug === (selected as { slug: string }).slug)) selected = null;
		if (selected === null && !composingNew && chats.loaded) {
			const r = rows[0];
			if (r) selected = r.kind === 'chat' ? { kind: 'chat', id: r.id } : { kind: 'task', slug: r.slug };
		}
	});

	// Settings load after the panel: pick up the default model once it is known.
	$effect(() => {
		if (!newModel) newModel = chats.defaults().model ?? '';
	});

	// A chat opened after a restart: rebuild its timeline from the saved transcript.
	$effect(() => {
		if (selected?.kind !== 'chat') return;
		const id = selected.id;
		untrack(() => void chats.open(id));
	});

	function select(s: Selection) {
		selected = s;
		composingNew = false;
		showList = false;
		renaming = false;
		optionNote = '';
	}

	function newChat() {
		selected = null;
		composingNew = true;
		showList = false;
		renaming = false;
		optionNote = '';
		const d = chats.defaults();
		newModel = d.model ?? '';
		newMode = d.permissionMode;
	}

	async function startChat(text: string, attachments: Attachment[]) {
		busy = true;
		try {
			const cwd: ChatCwd = newWhere ? { kind: 'task', slug: newWhere } : { kind: 'folder' };
			const id = await chats.create({ prompt: text, cwd, model: newModel.trim() || chats.defaults().model, permissionMode: newMode, attachments });
			if (id) {
				select({ kind: 'chat', id });
				draft = '';
				draftFiles = [];
			}
		} catch (e) {
			status.flash(t('chat.sendFailed', { error: String(e) }), 10000);
		} finally {
			busy = false;
		}
	}

	async function sendChat(text: string, attachments: Attachment[]) {
		if (!chatMeta || chatRun?.status === 'starting') return;
		const sent = await chats.send(chatMeta.id, text, attachments);
		if (sent) {
			followUp = '';
			followUpFiles = [];
		}
	}

	async function sendTask(text: string, attachments: Attachment[]) {
		if (!taskMeta || taskRun?.status === 'starting') return;
		followUp = '';
		followUpFiles = [];
		await adeTasks.followUp(taskMeta.slug, text, attachments);
	}

	async function changeModel(model: string) {
		if (!chatMeta) return;
		const when = await chats.setModel(chatMeta.id, model);
		optionNote = when === 'live' ? t('chat.panel.appliedNow') : when === 'next' ? t('chat.panel.appliedNext') : '';
	}

	async function changeMode(mode: PermissionMode) {
		if (!chatMeta) return;
		const when = await chats.setPermissionMode(chatMeta.id, mode);
		optionNote = when === 'live' ? t('chat.panel.appliedNow') : when === 'next' ? t('chat.panel.appliedNext') : '';
	}

	function startRename() {
		if (!chatMeta) return;
		renameText = chatMeta.title;
		renaming = true;
	}

	function finishRename(save: boolean) {
		if (!renaming) return;
		if (save && chatMeta) chats.rename(chatMeta.id, renameText);
		renaming = false;
	}

	async function removeChat() {
		if (!chatMeta) return;
		const ok = await ask(t('chat.panel.deleteConfirm', { title: chatMeta.title }), { kind: 'warning', okLabel: t('common.delete') });
		if (ok && (await chats.remove(chatMeta.id))) selected = null;
	}

	/** "Promote to task": a new ADE task (own worktree) started with the chat's first prompt. The chat stays. */
	async function promote() {
		if (!chatMeta) return;
		busy = true;
		try {
			const slug = await adeTasks.create({ title: chatMeta.title, prompt: chatMeta.prompt || chatMeta.title, base: '', mode: 'timeline', open: false });
			if (slug) select({ kind: 'task', slug });
		} finally {
			busy = false;
		}
	}

	const cwdLabel = (cwd: ChatCwd) => (cwd.kind === 'folder' ? workspace.name || t('chat.panel.cwdFolder') : `kingu/${cwd.slug}`);
	const MODE_LABEL: Record<PermissionMode, () => string> = {
		default: () => t('chat.panel.mode.default'),
		acceptEdits: () => t('chat.panel.mode.acceptEdits'),
		plan: () => t('chat.panel.mode.plan')
	};
	/** Model choices: the default from settings, the chat's own, and Claude's aliases. */
	function modelChoices(current: string | null): string[] {
		const d = chats.defaults().model;
		return [...new Set([current, d, 'opus', 'sonnet', 'haiku'].filter((m): m is string => !!m))];
	}
	const rowStatus = (r: (typeof rows)[number]): RunStatus | undefined => (r.kind === 'chat' ? chats.run(r.id)?.status : runtime.run(r.slug)?.status);

	const DOT: Record<RunStatus, string> = {
		starting: 'bg-(--vscode-descriptionForeground)',
		running: 'bg-(--vscode-editorInfo-foreground) animate-pulse',
		waiting: 'bg-(--vscode-editorWarning-foreground)',
		idle: 'bg-[#73C991]',
		stopped: 'bg-(--vscode-descriptionForeground)',
		failed: 'bg-(--vscode-errorForeground)',
		done: 'bg-(--vscode-descriptionForeground)'
	};
	const ICON_BTN = 'grid size-[22px] shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const TEXT_BTN = 'rounded-sm border border-(--vscode-widget-border) px-1.5 hover:bg-(--vscode-toolbar-hoverBackground)';
	const CHIP_SELECT =
		'h-5 max-w-32 truncate rounded-sm border border-transparent bg-transparent text-xs text-(--vscode-descriptionForeground) outline-none hover:border-(--vscode-widget-border) focus:border-(--vscode-focusBorder)';
	// Starters fill the prompt (they never send), like the Agents layout's empty composer.
	const STARTERS: { icon: IconName; label: () => string; text: () => string }[] = [
		{ icon: 'bug', label: () => t('chat.panel.starter.bug'), text: () => t('chat.panel.starter.bugText') },
		{ icon: 'check', label: () => t('chat.panel.starter.test'), text: () => t('chat.panel.starter.testText') },
		{ icon: 'code', label: () => t('chat.panel.starter.explain'), text: () => t('chat.panel.starter.explainText') }
	];
	const title = $derived(composingNew || !selected ? t('chat.panel.newChat') : (chatMeta?.title ?? taskMeta?.title ?? ''));
</script>

<div class="flex h-full flex-col text-[13px]">
	<!-- Session switcher + actions (VS Code chat view title actions). -->
	<div class="flex h-[30px] shrink-0 items-center gap-1 px-2">
		<button
			class={[ICON_BTN, showList && 'bg-(--vscode-toolbar-activeBackground)']}
			aria-label={t('chat.panel.sessions')}
			title={t('chat.panel.sessions')}
			aria-pressed={showList}
			onclick={() => (showList = !showList)}><Icon name="menu" size={16} /></button
		>
		{#if renaming && chatMeta}
			<input
				class="h-[22px] min-w-0 flex-1 rounded-sm border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1 text-[13px] text-(--vscode-input-foreground) outline-none"
				aria-label={t('chat.panel.rename')}
				bind:value={renameText}
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.isComposing) finishRename(true);
					else if (e.key === 'Escape') finishRename(false);
				}}
				onblur={() => finishRename(true)}
				{@attach (el) => el.focus()}
			/>
		{:else}
			<span class="min-w-0 flex-1 truncate" title={title}>{title}</span>
		{/if}
		<button class={ICON_BTN} aria-label={t('chat.panel.newChat')} title={t('chat.panel.newChat')} disabled={!workspace.root} onclick={newChat}><Icon name="plus" size={16} /></button>
		<button class={ICON_BTN} aria-label={t('chat.panel.openInAgents')} title={t('chat.panel.openInAgents')} onclick={() => appMode.setMode('agents')}>
			<Icon name="agentsLayout" size={16} />
		</button>
	</div>

	{#if !showList && chatMeta}
		<div class="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-xs text-(--vscode-descriptionForeground)">
			{#if chatRun && !chatRun.ended}<span class={['size-2 shrink-0 rounded-full', DOT[chatRun.status]]} title={STATUS_LABEL[chatRun.status]}></span>{/if}
			<span class="flex min-w-0 flex-1 items-center gap-1 truncate" title={t('chat.panel.cwdLabel')}>
				<Icon name={chatMeta.cwd.kind === 'folder' ? 'folder' : 'branch'} size={12} />
				<span class="truncate font-mono">{cwdLabel(chatMeta.cwd)}</span>
			</span>
			{#if chatWorking && chatRun?.runId !== undefined}
				<button class={TEXT_BTN} title={t('chat.panel.stopTurn')} onclick={() => chatMeta && chats.interrupt(chatMeta.id)}>{t('chat.panel.stopTurnLabel')}</button>
			{/if}
			{#if chatLive}
				<button class="hover:text-(--vscode-errorForeground)" title={t('chat.panel.endSession')} onclick={() => chatMeta && chats.stop(chatMeta.id)}>{t('chat.panel.endSessionLabel')}</button>
			{/if}
			<button class={ICON_BTN} aria-label={t('chat.panel.rename')} title={t('chat.panel.rename')} onclick={startRename}><Icon name="edit" size={13} /></button>
			<button class={ICON_BTN} aria-label={t('chat.panel.promote')} title={t('chat.panel.promoteHint')} disabled={busy} onclick={promote}><Icon name="tasks" size={13} /></button>
			<button class={ICON_BTN} aria-label={t('chat.panel.delete')} title={t('chat.panel.delete')} disabled={chatLive} onclick={removeChat}><Icon name="trash" size={13} /></button>
		</div>
	{:else if !showList && taskMeta}
		<div class="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-xs text-(--vscode-descriptionForeground)">
			{#if taskRun}<span class={['size-2 shrink-0 rounded-full', DOT[taskRun.status]]} title={STATUS_LABEL[taskRun.status]}></span>{/if}
			<button class="min-w-0 flex-1 truncate text-left font-mono hover:underline" title={t('chat.panel.openTask')} onclick={() => taskMeta && adeTasks.openTask(taskMeta.slug)}
				>kingu/{taskMeta.slug}</button
			>
			{#if taskRt?.working && taskRun?.runId !== undefined}
				<button class={TEXT_BTN} title={t('chat.panel.stopTurn')} onclick={() => taskMeta && adeTasks.interrupt(taskMeta.slug)}>{t('chat.panel.stopTurnLabel')}</button>
			{/if}
			{#if taskRt?.live && !terminalTask}
				<button class="hover:text-(--vscode-errorForeground)" title={t('chat.panel.endSession')} onclick={() => taskMeta && adeTasks.stop(taskMeta.slug)}>{t('chat.panel.endSessionLabel')}</button>
			{/if}
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-hidden border-t border-(--vscode-sideBar-border)">
		{#if showList}
			<!-- Sessions of this folder, newest first. -->
			<ul class="h-full overflow-y-auto py-1" aria-label={t('chat.panel.sessions')}>
				{#each rows as r (r.kind === 'chat' ? `c:${r.id}` : `t:${r.slug}`)}
					{@const st = rowStatus(r)}
					{@const active = (r.kind === 'chat' && selected?.kind === 'chat' && selected.id === r.id) || (r.kind === 'task' && selected?.kind === 'task' && selected.slug === r.slug)}
					<li class={['flex h-[26px] items-center gap-1.5 px-3 hover:bg-(--vscode-list-hoverBackground)', active && 'bg-(--vscode-list-inactiveSelectionBackground)']}>
						<button
							class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
							onclick={() => select(r.kind === 'chat' ? { kind: 'chat', id: r.id } : { kind: 'task', slug: r.slug })}
						>
							<span class="shrink-0 text-(--vscode-descriptionForeground)"><Icon name={r.kind === 'chat' ? 'agent' : r.terminal ? 'terminal' : 'branch'} size={14} /></span>
							<span class="min-w-0 flex-1 truncate">{r.title}</span>
							{#if st && st !== 'done' && st !== 'stopped'}<span class={['size-2 shrink-0 rounded-full', DOT[st]]} title={STATUS_LABEL[st]}></span>{/if}
						</button>
						{#if r.kind === 'task' && r.terminal}
							<!-- Hand-off only: never sends, never clears a draft. -->
							<button class="shrink-0 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => openAgents()}>{t('chat.panel.openInAgentsShort')}</button>
						{/if}
					</li>
				{:else}
					<li class="px-3 py-2 text-(--vscode-descriptionForeground)">{t('chat.panel.noSessions')}</li>
				{/each}
			</ul>
		{:else if chatMeta}
			<AgentTimeline
				run={chatRun}
				onanswer={(p, decision, message, answers) => chatMeta && chats.answer(chatMeta.id, p.request_id, decision, message, answers)}
				class="h-full p-3"
			>
				{#snippet empty()}
					<p class="text-(--vscode-descriptionForeground)">{t('chat.panel.noHistory')}</p>
				{/snippet}
			</AgentTimeline>
		{:else if taskMeta && terminalTask}
			<div class="grid h-full place-items-center p-6 text-center">
				<div class="max-w-64 space-y-2 text-(--vscode-descriptionForeground)">
					<div class="flex justify-center"><Icon name="terminal" size={28} /></div>
					<p class="text-(--vscode-foreground)">{t('chat.panel.terminalHint', { cli: cliOf(taskMeta.agent)?.[0] ?? '' })}</p>
					<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => openAgents()}>{t('chat.panel.openInAgents')}</button>
					<CliQuestion slug={taskMeta.slug} class="text-left text-xs" />
				</div>
			</div>
		{:else if taskMeta}
			<AgentTimeline run={taskRun} onanswer={(p, decision, message, answers) => taskMeta && adeTasks.answer(taskMeta.slug, p.request_id, decision, message, answers)} class="h-full p-3">
				{#snippet empty()}
					<p class="text-(--vscode-descriptionForeground)">{taskMeta?.session_id ? t('chat.panel.noTaskHistoryResume') : t('chat.panel.noTaskHistory')}</p>
				{/snippet}
			</AgentTimeline>
		{:else}
			<div class="grid h-full place-items-center p-6 text-center">
				<div class="flex max-w-72 flex-col items-center gap-2 text-(--vscode-descriptionForeground)">
					<span class="text-(--vscode-foreground)"><Icon name="agent" size={40} /></span>
					<p class="text-sm font-semibold text-(--vscode-foreground)">{t('chat.panel.emptyTitle')}</p>
					<p class="text-xs leading-5">{workspace.root ? t('chat.panel.emptyBody') : t('chat.panel.noFolder')}</p>
					<div class="mt-2 flex flex-wrap justify-center gap-1.5">
						{#each STARTERS as s (s.icon)}
							<button
								class="flex h-7 items-center gap-1.5 rounded-full border border-(--vscode-widget-border) px-3 text-xs hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
								onclick={() => (draft = draft.trim() ? `${s.text()}${draft}` : s.text())}
							>
								<Icon name={s.icon} size={13} />{s.label()}
							</button>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</div>

	<div class="shrink-0 p-2">
		{#if showList}
			<!-- The list has no composer; pick a session or start a new chat. -->
		{:else if chatMeta}
			<Composer
				bind:value={followUp}
				attach
				bind:attachments={followUpFiles}
				placeholder={chatLive ? t('chat.panel.placeholderLive') : (chatRun?.sessionId ?? chatMeta.session_id) ? t('chat.panel.placeholderResume') : t('chat.panel.placeholderNew')}
				disabled={chatRun?.status === 'starting'}
				onsubmit={sendChat}
			>
				{#snippet chips()}
					<select class={CHIP_SELECT} aria-label={t('chat.panel.model')} title={t('chat.panel.model')} value={chatMeta.model ?? ''} onchange={(e) => changeModel(e.currentTarget.value)}>
						{#each modelChoices(chatMeta.model) as m (m)}<option value={m}>{m}</option>{/each}
					</select>
					<select
						class={CHIP_SELECT}
						aria-label={t('chat.panel.mode')}
						title={t('chat.panel.mode')}
						value={chatMeta.permission_mode ?? 'default'}
						onchange={(e) => changeMode(e.currentTarget.value as PermissionMode)}
					>
						{#each PERMISSION_MODES as m (m)}<option value={m}>{MODE_LABEL[m]()}</option>{/each}
					</select>
				{/snippet}
			</Composer>
			{#if optionNote}<p class="px-1 pt-1 text-xs text-(--vscode-descriptionForeground)" role="status">{optionNote}</p>{/if}
		{:else if taskMeta && terminalTask}
			<!-- The CLI takes input in its own terminal. -->
		{:else if taskMeta}
			<Composer
				bind:value={followUp}
				attach
				bind:attachments={followUpFiles}
				placeholder={taskRt?.live ? t('chat.panel.placeholderLive') : (taskRun?.sessionId ?? taskMeta.session_id) ? t('chat.panel.placeholderResume') : t('chat.panel.placeholderNew')}
				disabled={taskRun?.status === 'starting'}
				onsubmit={sendTask}
			>
				{#snippet chips()}<span class="truncate">{taskRun?.model ?? taskMeta.model ?? ''}</span>{/snippet}
			</Composer>
		{:else}
			<Composer
				bind:value={draft}
				attach
				bind:attachments={draftFiles}
				placeholder={t('chat.panel.placeholderStart')}
				disabled={!workspace.root}
				{busy}
				autofocus={composingNew}
				onsubmit={startChat}
			>
				{#snippet chips()}
					<select class={CHIP_SELECT} aria-label={t('chat.panel.cwdLabel')} title={t('chat.panel.cwdLabel')} bind:value={newWhere}>
						<option value="">{workspace.name || t('chat.panel.cwdFolder')}</option>
						{#each taskWorktrees as slug (slug)}<option value={slug}>kingu/{slug}</option>{/each}
					</select>
					<select class={CHIP_SELECT} aria-label={t('chat.panel.model')} title={t('chat.panel.model')} bind:value={newModel}>
						{#each modelChoices(newModel) as m (m)}<option value={m}>{m}</option>{/each}
					</select>
					<select class={CHIP_SELECT} aria-label={t('chat.panel.mode')} title={t('chat.panel.mode')} bind:value={newMode}>
						{#each PERMISSION_MODES as m (m)}<option value={m}>{MODE_LABEL[m]()}</option>{/each}
					</select>
				{/snippet}
			</Composer>
		{/if}
	</div>
</div>
