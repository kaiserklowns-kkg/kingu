<script lang="ts">
	// Inbox (VS Code 1.146 Inbox mode, `sessions.list.inboxEnabled`; Orca's "Needs you"): every
	// agent that needs you — tasks of every added project, chats, agents in SSH terminals — in
	// VS Code's sections: Inbox (questions, approvals, failures, finished work to review), Working,
	// On hold, Acknowledged. Inbox folds like Orca's Needs you: approvals first and never hidden,
	// five rows, then "Show N more". Dismiss / Put on Hold / Snooze / Return to Inbox never stop,
	// archive or answer anything; Undo reverses the last one. Kingu only: Allow / Deny on a chat's or
	// agent-host task's permission row.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { sessionInbox } from './sessionInbox.svelte.ts';
	import { foldInbox, snoozeChoices, type InboxEntry, type InboxNeed, type InboxSection, type SnoozeChoice } from './sessionInbox.ts';
	import { timeAgo } from './model';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, QUESTION_DOT, STATUS_DOT } from './ui';

	let collapsed = $state<Record<InboxSection, boolean>>({ inbox: false, working: false, onHold: false, acknowledged: true });
	let snoozing = $state<string | null>(null);
	let focusedKey = $state<string | null>(null);

	const fold = $derived(foldInbox(sessionInbox.view.inbox, sessionInbox.expanded, focusedKey));
	const sections = $derived(
		(['working', 'onHold', 'acknowledged'] as const).map((id) => ({ id, rows: sessionInbox.view[id] })).filter((s) => s.rows.length)
	);

	const DOT: Record<InboxNeed, string> = {
		approval: STATUS_DOT.waiting,
		question: QUESTION_DOT,
		failed: STATUS_DOT.failed,
		review: STATUS_DOT.review,
		working: STATUS_DOT.running
	};
	const needLabel = (n: InboxNeed) => t(`inbox.need.${n}`);
	const sourceLabel = (e: InboxEntry) => t(`inbox.source.${e.source}`);
	const sectionLabel = (s: InboxSection) => t(`inbox.section.${s}`);
	const snoozeLabel = (c: SnoozeChoice) => t(`inbox.snooze.${c.id}`);

	function describeState(e: InboxEntry): string | null {
		const s = sessionInbox.stateOf(e.key);
		if (s?.kind === 'snoozed') return t('inbox.snoozedUntil', { when: new Date(s.until).toLocaleString() });
		if (s?.kind === 'untilActivity') return t('inbox.snoozedUntilActivity');
		if (s?.kind === 'hold') return t('inbox.onHold');
		return null;
	}

	function pickSnooze(e: InboxEntry, c: SnoozeChoice) {
		snoozing = null;
		sessionInbox.snooze(e, c);
	}
</script>

{#snippet row(e: InboxEntry, section: InboxSection)}
	{@const state = describeState(e)}
	<li class="group flex items-start gap-2 rounded px-2 py-1.5 hover:bg-(--vscode-list-hoverBackground)" aria-label={e.title} onfocusin={() => (focusedKey = e.key)} onfocusout={() => (focusedKey = null)}>
		<span class={['mt-1.5 size-2 shrink-0 rounded-full', DOT[e.need]]} aria-hidden="true"></span>
		<button class="min-w-0 flex-1 text-left" onclick={() => sessionInbox.open(e)} title={t('inbox.open')}>
			<span class="flex items-center gap-2">
				<span class="truncate text-[13px] font-medium">{e.title}</span>
				<span class="shrink-0 rounded border border-(--vscode-widget-border) px-1 text-[10px] text-(--vscode-descriptionForeground)">{needLabel(e.need)}</span>
			</span>
			{#if e.detail}<span class="block truncate text-xs text-(--vscode-descriptionForeground)">{e.detail}</span>{/if}
			<span class="block text-[10px] text-(--vscode-descriptionForeground)/80">{sourceLabel(e)} · {e.where} · {timeAgo(e.updatedAt, sessionInbox.now)}{#if state} · {state}{/if}</span>
		</button>
		<div class="flex shrink-0 items-center gap-1">
			{#if e.answer && section === 'inbox'}
				<!-- Kingu only: answer the permission prompt here, once. -->
				<button class={BUTTON} title={t('inbox.allowTitle', { tool: e.answer.tool })} onclick={() => sessionInbox.answer(e, true)}>{t('inbox.allow')}</button>
				<button class={BUTTON_SECONDARY} onclick={() => sessionInbox.answer(e, false)}>{t('inbox.deny')}</button>
			{/if}
			{#if section === 'inbox' || section === 'working'}
				<span class="relative">
					<button class={ICON_BUTTON} aria-label={t('inbox.snooze')} title={t('inbox.snooze')} aria-expanded={snoozing === e.key} onclick={() => (snoozing = snoozing === e.key ? null : e.key)}><Icon name="clock" size={14} /></button>
					{#if snoozing === e.key}
						<div class="absolute top-full right-0 z-20 mt-1 w-48 rounded-md border border-(--vscode-widget-border) bg-(--vscode-menu-background,var(--vscode-editorWidget-background)) py-1 text-xs shadow-lg shadow-black/30" role="menu" aria-label={t('inbox.snooze')}>
							{#each snoozeChoices(Date.now()) as c (c.id)}
								<button class="block w-full px-3 py-1 text-left hover:bg-(--vscode-list-hoverBackground)" role="menuitem" onclick={() => pickSnooze(e, c)}>{snoozeLabel(c)}</button>
							{/each}
						</div>
					{/if}
				</span>
				<button class={ICON_BUTTON} aria-label={t('inbox.hold')} title={t('inbox.hold')} onclick={() => sessionInbox.hold(e)}><Icon name="pause" size={14} /></button>
				{#if section === 'inbox'}
					<button class={ICON_BUTTON} aria-label={t('inbox.dismiss')} title={t('inbox.dismissTitle')} onclick={() => sessionInbox.dismiss(e)}><Icon name="close" size={14} /></button>
				{/if}
			{:else}
				<button class={BUTTON_SECONDARY} onclick={() => sessionInbox.resume(e)}>{t('inbox.return')}</button>
			{/if}
		</div>
	</li>
{/snippet}

<svelte:window onkeydown={(e) => e.key === 'Escape' && (snoozing = null)} />

<div class="h-full overflow-y-auto bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<header class="sticky top-0 z-10 flex items-center gap-2 border-b border-(--vscode-widget-border) bg-(--vscode-editor-background)/95 px-5 py-3 backdrop-blur">
		<Icon name="bellDot" size={18} />
		<div class="min-w-0 flex-1">
			<h1 class="text-sm font-semibold">{t('inbox.title')}</h1>
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('inbox.subtitle')}</p>
		</div>
	</header>

	<main class="mx-auto max-w-4xl space-y-4 p-5">
		{#if sessionInbox.lastChange}
			<div class="flex items-center gap-2 rounded border border-(--vscode-widget-border) px-3 py-1.5 text-xs" role="status">
				<span class="flex-1">{sessionInbox.lastChange.label}</span>
				<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => sessionInbox.undo()}>{t('inbox.undo')}</button>
				<button class={ICON_BUTTON} aria-label={t('inbox.closeNotice')} onclick={() => (sessionInbox.lastChange = null)}><Icon name="close" size={12} /></button>
			</div>
		{/if}

		<section aria-label={sectionLabel('inbox')}>
			<button class="flex w-full items-center gap-1 py-1 text-xs font-semibold tracking-wide uppercase" aria-expanded={!collapsed.inbox} onclick={() => (collapsed.inbox = !collapsed.inbox)}>
				<Icon name={collapsed.inbox ? 'chevronRight' : 'chevronDown'} size={12} />
				{sectionLabel('inbox')}
				<span class="font-normal text-(--vscode-descriptionForeground)">{sessionInbox.view.inbox.length}</span>
			</button>
			{#if !collapsed.inbox}
				{#if sessionInbox.view.inbox.length}
					<ul>
						{#each fold.visible as e (e.key)}{@render row(e, 'inbox')}{/each}
					</ul>
					{#if fold.folds}
						<button class="mt-1 px-2 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => (sessionInbox.expanded = !sessionInbox.expanded)}>
							{sessionInbox.expanded ? t('inbox.showFewer') : t('inbox.showMore', { count: fold.hidden })}
						</button>
					{/if}
				{:else}
					<p class="px-2 py-3 text-xs text-(--vscode-descriptionForeground)">{t('inbox.empty')}</p>
				{/if}
			{/if}
		</section>

		{#each sections as s (s.id)}
			<section aria-label={sectionLabel(s.id)}>
				<button class="flex w-full items-center gap-1 py-1 text-xs font-semibold tracking-wide uppercase" aria-expanded={!collapsed[s.id]} onclick={() => (collapsed[s.id] = !collapsed[s.id])}>
					<Icon name={collapsed[s.id] ? 'chevronRight' : 'chevronDown'} size={12} />
					{sectionLabel(s.id)}
					<span class="font-normal text-(--vscode-descriptionForeground)">{s.rows.length}</span>
				</button>
				{#if !collapsed[s.id]}
					<ul>
						{#each s.rows as e (e.key)}{@render row(e, s.id)}{/each}
					</ul>
				{/if}
			</section>
		{/each}
	</main>
</div>
