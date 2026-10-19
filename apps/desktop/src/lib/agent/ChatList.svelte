<script lang="ts" module>
	import type { ChatView, Turn } from './chatParts';
	import type { Vote } from './events';

	export type ChatListActions = {
		/** Sends the last request again. */
		retry?: () => void;
		/** Puts a request back in the input to change and send as a new message. */
		edit?: (request: NonNullable<Turn['request']>) => void;
		/**
		 * Edit in place (VS Code's `chat.editRequests: inline`): a request with a checkpoint turns
		 * into an editor; on Enter its checkpoint and the new text come here. Over `edit` for those.
		 */
		editInline?: (request: NonNullable<Turn['request']>, checkpoint: number, text: string) => Promise<unknown> | void;
		/** The plan card's Implement (the last turn's ExitPlanMode only): leave plan mode and carry it out. */
		implement?: () => void;
		/** Thumbs up / down on the answer to a chat request (null takes the vote back). */
		feedback?: (request: number, vote: Vote | null) => void;
		/** "Remember this" on a request or an answer: its text, or the selection in it. */
		remember?: (text: string) => void;
		/** Follow-up suggestions under the last answer, and what a click on one does. */
		followups?: { items: string[]; pick: (text: string) => void };
	};
</script>

<script lang="ts">
	// A run as VS Code's chat list (chatListRenderer): each request, then its response made of
	// parts: markdown with code block actions, thinking (collapsed), tool calls (ChatToolRow:
	// one-line rows that expand to their input and output, edited-file pills, plan cards, subagents
	// with their own calls nested), approval and question cards, errors with Retry, a "Working…" row
	// while the turn runs, and "N files changed" under a finished chat request. Internal events are not shown (chatParts.ts). Shared by
	// the Agent panel and the ADE task page.
	import type { Snippet } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { chatLook } from '#lib/ade/chatLook.ts';
	import { t } from '#lib/i18n/index.ts';
	import PermissionCard from './PermissionCard.svelte';
	import QuestionCard from './QuestionCard.svelte';
	import ChatMarkdown from './ChatMarkdown.svelte';
	import ChatToolRow from './ChatToolRow.svelte';
	import ChatRequestChanges from './ChatRequestChanges.svelte';
	import { answersFor, parseAsk } from './ask';
	import { buildTurns, responseText, type Part } from './chatParts';
	import { contextLabel } from './chatPrompt';
	import { formatUsage, type Decision, type PermissionRequest } from './events';
	import { usageDisplay } from './chatExtras';

	let {
		run,
		onanswer,
		actions = {},
		cwd = null,
		root = null,
		empty,
		checkpoint,
		reverted,
		chatId = null,
		class: klass = ''
	}: {
		run: ChatView | undefined;
		/** `answers`: an AskUserQuestion's, question text → answer (with `allow`). */
		onanswer?: (request: PermissionRequest, decision: Decision, message?: string, answers?: Record<string, string>) => void;
		actions?: ChatListActions;
		/** Where the agent runs: tool rows show paths relative to it. */
		cwd?: string | null;
		/** The open folder: file links open relative to it. */
		root?: string | null;
		empty?: Snippet;
		/** Chat edits: actions on each request (Restore checkpoint, Fork), given its request index, the request and whether it is the first. */
		checkpoint?: Snippet<[number, NonNullable<Turn['request']>, boolean]>;
		/** Chat edits: whether a request was reverted by a restored checkpoint (dimmed, like VS Code). */
		reverted?: (request: number) => boolean;
		/** The agent chat shown (edited-file pills open its diffs; "N files changed" per request); null for ADE tasks. */
		chatId?: string | null;
		class?: string;
	} = $props();

	let list: HTMLDivElement;
	/** Follow new output while the list is scrolled to the bottom (VS Code's scroll lock). */
	let stick = true;
	const look = $derived(chatLook((id) => settings.get(id)));
	const usage = $derived(usageDisplay(settings.get('kingu.chat.usage')));
	/** "Remember this": the text selected inside this list, else the whole message. */
	const rememberText = (text: string) => {
		const sel = getSelection();
		const picked = sel && !sel.isCollapsed && list?.contains(sel.anchorNode) ? sel.toString().trim() : '';
		actions.remember?.(picked || text);
	};
	const turns = $derived(run ? buildTurns(run) : []);
	let open = $state<Record<string, boolean>>({});
	let copied = $state<number | null>(null);
	/** The turn whose request is edited in place, and its text. */
	let editing = $state<number | null>(null);
	let editText = $state('');
	let editBusy = $state(false);
	const firstRequest = $derived(turns.findIndex((x) => x.request));

	function startEdit(ti: number, text: string) {
		editing = ti;
		editText = text;
	}

	async function submitEdit(req: NonNullable<Turn['request']>, checkpoint: number) {
		const text = editText.trim();
		if (!text || editBusy) return;
		editBusy = true;
		try {
			await actions.editInline?.(req, checkpoint, text);
			editing = null;
		} finally {
			editBusy = false;
		}
	}

	function onEditKey(e: KeyboardEvent, req: NonNullable<Turn['request']>, checkpoint: number) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void submitEdit(req, checkpoint);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			editing = null;
		}
	}

	$effect(() => {
		void run?.items.length;
		void run?.draft.text.length;
		void run?.draft.thinking.length;
		void run?.status;
		if (list && stick) list.scrollTop = list.scrollHeight;
	});

	function onscroll() {
		stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
	}

	async function copy(text: string, i: number) {
		try {
			await navigator.clipboard.writeText(text);
			copied = i;
			setTimeout(() => copied === i && (copied = null), 1500);
		} catch (e) {
			status.flash(t('chatView.copyFailed', { error: String(e) }), 5000);
		}
	}

	const toggle = (key: string) => (open[key] = !open[key]);
	/** The part that shows the turn is busy: no spinner under a streaming text or an open question. */
	const showsProgress = (parts: Part[]) => {
		const last = parts[parts.length - 1];
		return !(last && ((last.kind === 'markdown' && last.streaming) || last.kind === 'confirmation'));
	};
	/** Tool calls of a turn waiting for approval (a subagent's row counts its own). */
	const pendingTools = (parts: Part[]) =>
		new Set(parts.flatMap((p) => (p.kind === 'confirmation' && !run?.decisions[p.request.request_id] && p.request.tool_use_id ? [p.request.tool_use_id] : [])));
	const isAsk = (r: PermissionRequest) => r.tool === 'AskUserQuestion';
	const ACTION = 'grid size-[22px] place-items-center rounded text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

<div
	bind:this={list}
	{onscroll}
	class={['kg-selectable kg-chat min-h-0 overflow-y-auto', klass]}
	aria-live="polite"
	style:font-size="{look.fontSize}px"
	style:--kg-chat-code-size="{look.codeFontSize}px"
	style:font-family={look.fontFamily}
	style:filter={look.contrast === 100 ? undefined : `contrast(${look.contrast}%)`}
>
	<div class="mx-auto flex flex-col gap-3" style:max-width={look.maxWidth}>
		{#if turns.length}
			{#each turns as turn, ti (ti)}
				{@const last = ti === turns.length - 1}
				{@const dim = (turn.checkpoint != null && !!reverted?.(turn.checkpoint)) || (editing !== null && ti > editing)}
				<div class={['flex flex-col gap-3', dim && 'opacity-50']}>
				{#if turn.request}
					{@const req = turn.request}
					{@const inline = !!actions.editInline && turn.checkpoint != null}
					<!-- Request -->
					<div class="group/req flex flex-col items-end gap-1">
						{#if editing === ti && turn.checkpoint != null}
							{@const cp = turn.checkpoint}
							<div class="flex w-full flex-col gap-1 rounded-lg border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-2 py-1.5">
								<textarea
									class="min-h-12 w-full resize-y bg-transparent text-(--vscode-input-foreground) outline-none"
									aria-label={t('chatRewind.editLabel')}
									title={t('chatRewind.editHint')}
									bind:value={editText}
									disabled={editBusy}
									onkeydown={(e) => onEditKey(e, req, cp)}
									{@attach (el) => {
										el.focus();
										(el as HTMLTextAreaElement).select();
									}}
								></textarea>
								<div class="flex items-center justify-end gap-1 text-xs">
									<button type="button" class="rounded-sm px-1.5 py-0.5 hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => (editing = null)}>{t('common.cancel')}</button>
									<button
										type="button"
										class="rounded-sm bg-(--vscode-button-background) px-1.5 py-0.5 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-50"
										disabled={editBusy || !editText.trim()}
										onclick={() => submitEdit(req, cp)}>{t('chatRewind.editSend')}</button
									>
								</div>
							</div>
						{:else}
						<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
						<div
							class={['max-w-[90%] rounded-lg bg-(--vscode-chat-requestBackground,var(--vscode-input-background)) px-2.5 py-1.5 break-words whitespace-pre-wrap', inline && 'cursor-text']}
							role={inline ? 'button' : undefined}
							tabindex={inline ? 0 : undefined}
							title={inline ? t('chatRewind.editHint') : undefined}
							onclick={() => inline && !getSelection()?.toString() && startEdit(ti, req.text)}
							onkeydown={(e) => inline && e.key === 'Enter' && e.target === e.currentTarget && (e.preventDefault(), startEdit(ti, req.text))}
						>
							{req.text}
							{#if req.files.length || req.images.length}
								<div class="mt-1 flex flex-wrap gap-1">
									{#each req.files as f (f.path + (f.range?.startLine ?? ''))}
										<span class="flex max-w-48 items-center gap-1 rounded border border-(--vscode-widget-border) px-1 text-xs" title={f.path}>
											<Icon name="file" size={11} /><span class="truncate">{contextLabel(f)}</span>
										</span>
									{/each}
									{#each req.images as name (name)}
										<span class="flex max-w-48 items-center gap-1 rounded border border-(--vscode-widget-border) px-1 text-xs"><Icon name="image" size={11} /><span class="truncate">{name}</span></span>
									{/each}
								</div>
							{/if}
						</div>
						{/if}
						<div class="flex gap-0.5 opacity-0 transition-opacity group-hover/req:opacity-100 focus-within:opacity-100">
							{#if inline}
								<button type="button" class={ACTION} title={t('chatRewind.editHint')} aria-label={t('chatRewind.editLabel')} onclick={() => startEdit(ti, req.text)}><Icon name="edit" size={13} /></button>
							{:else if actions.edit}
								<button type="button" class={ACTION} title={t('chatView.editRequest')} aria-label={t('chatView.editRequest')} onclick={() => actions.edit?.(req)}><Icon name="edit" size={13} /></button>
							{/if}
							<button type="button" class={ACTION} title={t('chatView.copyRequest')} aria-label={t('chatView.copyRequest')} onclick={() => copy(req.text, -1 - ti)}>
								<Icon name={copied === -1 - ti ? 'check' : 'copy'} size={13} />
							</button>
							{#if actions.remember}
								<button type="button" class={ACTION} title={t('chatExtras.remember.hint')} aria-label={t('chatExtras.remember.label')} onclick={() => rememberText(req.text)}><Icon name="bookmark" size={13} /></button>
							{/if}
							{#if checkpoint && turn.checkpoint != null}{@render checkpoint(turn.checkpoint, req, ti === firstRequest)}{/if}
						</div>
					</div>
				{/if}

				<!-- Response -->
				<div class="flex flex-col gap-1.5">
					{#each turn.parts as part, pi (pi)}
						{@const key = `${ti}:${pi}`}
						{#if part.kind === 'markdown'}
							<ChatMarkdown text={part.text} streaming={part.streaming} {root} />
						{:else if part.kind === 'thinking'}
							<div>
								<button type="button" class="flex items-center gap-1 text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)" aria-expanded={!!open[key]} onclick={() => toggle(key)}>
									<Icon name={open[key] ? 'chevronDown' : 'chevronRight'} size={12} />
									{#if part.streaming}<span class="animate-pulse">{t('chatView.thinking')}</span>{:else}{t('chatView.thought')}{/if}
								</button>
								{#if open[key]}
									<p class="mt-1 border-l-2 border-(--vscode-widget-border) pl-2 whitespace-pre-wrap text-(--vscode-descriptionForeground) italic">{part.text}</p>
								{/if}
							</div>
						{:else if part.kind === 'tool'}
							<ChatToolRow {part} turnDone={turn.done} {cwd} {root} {chatId} pending={pendingTools(turn.parts)} onimplement={last ? actions.implement : undefined} />
						{:else if part.kind === 'confirmation'}
							{@const ev = part.request}
							{@const decided = run?.decisions[ev.request_id]}
							{#if part.reason}
								<div class="flex items-start gap-1.5 text-xs text-(--vscode-editorWarning-foreground)" role="note">
									<span class="mt-px shrink-0"><Icon name="warning" size={12} /></span><span class="min-w-0 break-words">{part.reason}</span>
								</div>
							{/if}
							{#if decided}
								<div class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)">
									<Icon name="circleDashed" size={13} />
									<span class="truncate">{isAsk(ev) ? t('chatView.questionDismissed') : t('chatView.permissionDenied', { tool: ev.tool })}</span>
								</div>
							{:else if onanswer && !run?.ended && isAsk(ev) && parseAsk(ev.input)}
								{@const ask = parseAsk(ev.input)!}
								<QuestionCard prompt={ask} onsubmit={(sels) => onanswer(ev, 'allow', undefined, answersFor(ask, sels))} ondismiss={() => onanswer(ev, 'deny')} />
							{:else if onanswer && !run?.ended}
								<PermissionCard request={ev} onanswer={(decision, message) => onanswer(ev, decision, message)} />
							{:else}
								<div class="flex items-center gap-1.5 text-(--vscode-editorWarning-foreground)">
									<Icon name="question" size={13} />
									<span class="truncate">{isAsk(ev) ? t('chatView.questionWaiting') : t('chatView.permissionWaiting', { tool: ev.tool })}</span>
								</div>
							{/if}
						{:else if part.kind === 'error'}
							<div class="flex items-start gap-1.5 rounded border border-(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground)) px-2 py-1.5" role="alert">
								<span class="mt-0.5 shrink-0 text-(--vscode-errorForeground)"><Icon name="error" size={14} /></span>
								<span class="min-w-0 flex-1 break-words whitespace-pre-wrap">{part.message}</span>
								{#if last && turn.done && actions.retry}
									<button type="button" class="shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={() => actions.retry?.()}>{t('chatView.retry')}</button>
								{/if}
							</div>
						{:else if part.kind === 'canceled'}
							<div class="text-(--vscode-descriptionForeground) italic">{t('chatView.canceled')}</div>
						{/if}
					{/each}

					{#if !turn.done && showsProgress(turn.parts)}
						<div class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)" role="status">
							<span class="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>
							{t('chatView.working')}
						</div>
					{/if}

					{#if turn.done && chatId && turn.checkpoint != null && !dim}
						<ChatRequestChanges {chatId} request={turn.checkpoint} />
					{/if}

					{#if turn.done && turn.request && turn.parts.length}
						{@const text = responseText(turn)}
						<div class="flex items-center gap-0.5">
							{#if text}
								<button type="button" class={ACTION} title={t('chatView.copyResponse')} aria-label={t('chatView.copyResponse')} onclick={() => copy(text, ti)}>
									<Icon name={copied === ti ? 'check' : 'copy'} size={13} />
								</button>
							{/if}
							{#if last && actions.retry}
								<button type="button" class={ACTION} title={t('chatView.retry')} aria-label={t('chatView.retry')} onclick={() => actions.retry?.()}><Icon name="refresh" size={13} /></button>
							{/if}
							{#if text && actions.remember}
								<button type="button" class={ACTION} title={t('chatExtras.remember.hint')} aria-label={t('chatExtras.remember.label')} onclick={() => rememberText(text)}><Icon name="bookmark" size={13} /></button>
							{/if}
							{#if actions.feedback && turn.checkpoint != null}
								{@const cp = turn.checkpoint}
								{#each [['up', 'thumbsUp', t('chatExtras.feedback.helpful')], ['down', 'thumbsDown', t('chatExtras.feedback.unhelpful')]] as const as [vote, icon, label] (vote)}
									<button
										type="button"
										class={[ACTION, turn.feedback === vote && 'text-(--vscode-foreground)']}
										title={label}
										aria-label={label}
										aria-pressed={turn.feedback === vote}
										onclick={() => actions.feedback?.(cp, turn.feedback === vote ? null : vote)}><Icon name={icon} size={13} filled={turn.feedback === vote} /></button
									>
								{/each}
							{/if}
							{#if turn.result && formatUsage(turn.result) && usage === 'hover'}
								<span class={[ACTION, 'cursor-default']} title={t('chatView.usage', { usage: formatUsage(turn.result) })} aria-label={t('chatView.usage', { usage: formatUsage(turn.result) })}>
									<Icon name="info" size={13} />
								</span>
							{:else if turn.result && formatUsage(turn.result) && usage === 'always'}
								<span class="ml-1 truncate text-xs text-(--vscode-descriptionForeground)">{formatUsage(turn.result)}</span>
							{/if}
						</div>
						{#if last && actions.followups?.items.length}
							<div class="flex flex-wrap gap-1.5" aria-label={t('chatExtras.followups')}>
								{#each actions.followups.items as f (f)}
									<button
										type="button"
										class="flex max-w-full items-center gap-1 rounded-full border border-(--vscode-widget-border) px-2.5 py-0.5 text-left text-xs text-(--vscode-textLink-foreground) hover:bg-(--vscode-toolbar-hoverBackground)"
										title={t('chatExtras.followupHint')}
										onclick={() => actions.followups?.pick(f)}><Icon name="sparkle" size={12} /><span class="truncate">{f}</span></button
									>
								{/each}
							</div>
						{/if}
					{/if}
				</div>
				</div>
			{/each}
		{:else}
			{@render empty?.()}
		{/if}
	</div>
</div>

<style>
	/* kingu.chat.codeFontSize: tool input/output and other monospace text. */
	.kg-chat :global(.font-mono) {
		font-size: var(--kg-chat-code-size);
	}
</style>
