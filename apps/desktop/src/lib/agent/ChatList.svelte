<script lang="ts" module>
	import type { ChatView, Turn } from './chatParts';
	import type { Vote } from './events';
	import type { RunModeControl } from './PermissionCard.svelte';

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
		/** Stop the running turn (the ■ in the running request's box, Cursor's). */
		stop?: () => void;
		/** Fork the chat at a request (the answer footer's branch icon). */
		fork?: (request: number) => void;
		/** When a request was sent (ms), for the answer footer's "Just now". */
		sentAt?: (request: number) => number | null;
		/** The chat's run mode, offered by the approval card's Allowlist menu. */
		runMode?: RunModeControl;
		/** Continue under a stopped last turn (Orca's): sends "continue". */
		continue?: () => void;
	};
</script>

<script lang="ts">
	// A run as VS Code's chat list (chatListRenderer): each request, then its response made of
	// parts (Cursor's look: each request in a rounded box like the composer, the first one pinned
	// to the top while its answer scrolls, with ■ Stop inside while it runs and the checkpoint's ↶
	// after; a finished turn folds its steps into "Worked for 2s"; quiet progress lines; a skipped
	// call is "Skipped rm"):
	// markdown with code block actions, thinking (collapsed), tool calls (ChatToolRow:
	// one-line rows that expand to their input and output, edited-file pills, plan cards, subagents
	// with their own calls nested), approval and question cards, errors with Retry, a "Working…" row
	// while the turn runs, and "N files changed" under a finished chat request. Internal events are not shown (chatParts.ts). Shared by
	// the Agent panel and the ADE task page.
	import type { Snippet } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { chatLook } from '#lib/ade/chatLook.ts';
	import { locale, t } from '#lib/i18n/index.ts';
	import PermissionCard from './PermissionCard.svelte';
	import QuestionCard from './QuestionCard.svelte';
	import McpRequestCard from './McpRequestCard.svelte';
	import { mcpChat } from './mcpChat.svelte.ts';
	import ChatMarkdown from './ChatMarkdown.svelte';
	import ChatToolRow from './ChatToolRow.svelte';
	import ArtifactCard from '#lib/artifacts/ArtifactCard.svelte';
	import { answersFor, parseAsk } from './ask';
	import { buildTurns, foldSteps, hiddenTools, responseText, splitVerb, workedFor, type Part } from './chatParts';
	import { timeAgo } from '#lib/ade/model.ts';
	import { skippedText } from './composer.ts';
	import { contextLabel } from './chatPrompt';
	import { formatUsage, type Decision, type PermissionRequest } from './events';
	import { usageDisplay } from './chatExtras';
	import { accessibleView, chatProvider } from '#lib/workbench/accessibleView.svelte.ts';
	import { continuable, foldsPrompt } from './chatTranscript.ts';
	import ChatReferences from './ChatReferences.svelte';
	import { turnReferences } from './chatReferences';
	import { THINKING_SCROLL_PX, thinkingStyle, thinkingView } from './chatSettings';

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
	// ⌥F2 in the chat: its requests and responses in the Accessible View.
	$effect(() => accessibleView.registerProvider(chatProvider(() => list, () => turns.map((x) => ({ request: x.request?.text, response: responseText(x), done: x.done })))));
	let open = $state<Record<string, boolean>>({});
	let copied = $state<number | null>(null);
	/** The turn whose request is edited in place, and its text. */
	let editing = $state<number | null>(null);
	let editText = $state('');
	let editBusy = $state(false);
	const firstRequest = $derived(turns.findIndex((x) => x.request));
	/** Long requests opened past their fold (Show more). */
	let unfolded = $state<Record<number, boolean>>({});
	const canContinue = $derived(!!actions.continue && continuable(turns, false));
	/** When a request was sent, for its row's tooltip. */
	const sentTitle = (checkpoint: number | null | undefined): string | undefined => {
		const at = checkpoint != null ? actions.sentAt?.(checkpoint) : null;
		return at ? t('chatTranscript.sentAt', { time: new Date(at).toLocaleString(locale() === 'th' ? 'th-TH' : 'en-US') }) : undefined;
	};

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
	// chat.agent.thinkingStyle: a thinking part is collapsed, open while the agent is on it, or in
	// a fixed-height panel that follows the text; a click on its header wins (chatSettings.ts).
	const thinking = $derived(thinkingStyle(settings.get('chat.agent.thinkingStyle')));
	/** The fixed-height thinking panels follow their text to the bottom. */
	const follow = (el: HTMLElement) => {
		const mo = new MutationObserver(() => (el.scrollTop = el.scrollHeight));
		mo.observe(el, { childList: true, characterData: true, subtree: true });
		el.scrollTop = el.scrollHeight;
		return () => mo.disconnect();
	};

	// How long each turn watched here took, for "Worked for Ns" when its result has no duration
	// (runtimes other than Claude Code): from when the turn was first seen running to when it ended.
	const startedAt: Record<number, number> = {};
	let endedAt = $state<Record<number, number>>({});
	$effect(() => {
		turns.forEach((turn, ti) => {
			if (!turn.done && startedAt[ti] === undefined) startedAt[ti] = Date.now();
			else if (turn.done && startedAt[ti] !== undefined && endedAt[ti] === undefined) endedAt = { ...endedAt, [ti]: Date.now() };
		});
	});
	const tookMs = (ti: number, turn: Turn): number | null => (turn.done && startedAt[ti] !== undefined && endedAt[ti] !== undefined ? endedAt[ti] - startedAt[ti] : null);
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
	data-chat-scroll
	class={['kg-selectable kg-chat min-h-0 min-w-0 overflow-x-hidden overflow-y-auto', klass]}
	aria-live="polite"
	style:font-size="{look.fontSize}px"
	style:--kg-chat-code-size="{look.codeFontSize}px"
	style:font-family={look.fontFamily}
	style:--kg-chat-code-font={look.codeFontFamily}
	style:--kg-chat-code-weight={look.codeFontWeight}
	style:--kg-chat-code-line={look.codeLineHeight ? `${look.codeLineHeight}px` : undefined}
	style:--kg-chat-code-wrap={look.codeWrap ? 'pre-wrap' : undefined}
	style:filter={look.contrast === 100 ? undefined : `contrast(${look.contrast}%)`}
>
	<div class="mx-auto flex w-full min-w-0 flex-col gap-3" style:max-width={look.maxWidth}>
		{#if turns.length}
			{#each turns as turn, ti (ti)}
				{@const last = ti === turns.length - 1}
				{@const dim = (turn.checkpoint != null && !!reverted?.(turn.checkpoint)) || (editing !== null && ti > editing)}
				{@const end = foldSteps(turn)}
				{@const took = workedFor(turn.result?.duration_ms ?? tookMs(ti, turn))}
				{@const folded = end > 0 && !open[`w:${ti}`]}
				{@const refs = turnReferences(turn.parts)}
				<div class={['flex flex-col gap-3', dim && 'opacity-50']} data-chat-turn={turn.request ? '' : undefined}>
				{#if turn.request}
					{@const req = turn.request}
					{@const inline = !!actions.editInline && turn.checkpoint != null}
					<!-- Request: a box like the composer; the first one stays pinned while its answer scrolls. -->
					<div class={['group/req flex flex-col items-end gap-1', ti === firstRequest && 'sticky -top-3 z-10 -mx-1 bg-(--vscode-sideBar-background) px-1 pt-3 pb-1']}>
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
						{@const folds = foldsPrompt(req.text)}
						<div class="flex w-full items-start gap-2 rounded-xl border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) py-2 pr-2 pl-3 outline-none focus-visible:border-(--vscode-focusBorder)" data-chat-request tabindex="-1" title={sentTitle(turn.checkpoint)}>
						<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
						<div
							class={['min-w-0 flex-1 break-words whitespace-pre-wrap', inline && 'cursor-text']}
							role={inline ? 'button' : undefined}
							tabindex={inline ? 0 : undefined}
							title={inline ? t('chatRewind.editHint') : undefined}
							onclick={() => inline && !getSelection()?.toString() && startEdit(ti, req.text)}
							onkeydown={(e) => inline && e.key === 'Enter' && e.target === e.currentTarget && (e.preventDefault(), startEdit(ti, req.text))}
						>
							{#if folds && !unfolded[ti]}
								<div class="max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">{req.text}</div>
							{:else}
								{req.text}
							{/if}
							{#if folds}
								<button
									type="button"
									class="mt-0.5 block text-xs text-(--vscode-textLink-foreground) hover:underline"
									aria-expanded={!!unfolded[ti]}
									onclick={(e) => {
										e.stopPropagation();
										unfolded[ti] = !unfolded[ti];
									}}>{unfolded[ti] ? t('chatTranscript.fold.less') : t('chatTranscript.fold.more')}</button
								>
							{/if}
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
							<div class="flex shrink-0 items-center">
								{#if !turn.done && last && actions.stop}
									<button
										type="button"
										class="grid size-6 place-items-center rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)] text-(--vscode-sideBar-background,var(--vscode-input-background)) hover:opacity-90"
										aria-label={t('chatView.stop')}
										title={t('chatView.stop')}
										onclick={() => actions.stop?.()}><span class="size-2.5 rounded-[2px] bg-current"></span></button
									>
								{:else if checkpoint && turn.checkpoint != null}{@render checkpoint(turn.checkpoint, req, ti === firstRequest)}{/if}
							</div>
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
						</div>
					</div>
				{/if}

				<!-- Response: an earlier finished turn folds its steps into "Worked for 2s" (Cursor's). -->
				<div class="flex flex-col gap-1.5">
					{#if refs.length}<ChatReferences {refs} {cwd} {root} />{/if}
					{#if end > 0}
						<button type="button" class="flex items-center gap-1 self-start text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)" aria-expanded={!folded} onclick={() => toggle(`w:${ti}`)}>
							{took ? t('composer.progress.workedFor', { time: took }) : t('composer.progress.worked')}
							<Icon name={folded ? 'chevronDown' : 'chevronUp'} size={12} />
						</button>
					{/if}
					{#each turn.parts as part, pi (pi)}
						{@const key = `${ti}:${pi}`}
						{#if folded && pi < end}
							<!-- folded into "Worked for" -->
						{:else if part.kind === 'markdown'}
							<ChatMarkdown text={part.text} streaming={part.streaming} {root} />
						{:else if part.kind === 'thinking'}
							{@const view = thinkingView(thinking, !!part.streaming || (!turn.done && pi === turn.parts.length - 1), open[key])}
							<div>
								<button
									type="button"
									class="flex items-center gap-1 text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
									aria-expanded={view === 'open'}
									title={view === 'scroll' ? t('chatRender.thinking.expand') : undefined}
									onclick={() => (open[key] = view !== 'open')}
								>
									<Icon name={view === 'closed' ? 'chevronRight' : 'chevronDown'} size={12} />
									{#if part.streaming}<span class="animate-pulse font-semibold">{t('chatView.thinking')}</span>{:else}<span><span class="font-semibold">{splitVerb(t('composer.progress.thought')).verb}</span> {splitVerb(t('composer.progress.thought')).rest}</span>{/if}
								</button>
								{#if view === 'scroll'}
									<p class="mt-1 overflow-y-auto border-l-2 border-(--vscode-widget-border) pl-2 whitespace-pre-wrap text-(--vscode-descriptionForeground) italic" style:max-height="{THINKING_SCROLL_PX}px" {@attach follow}>{part.text}</p>
								{:else if view === 'open'}
									<p class="mt-1 border-l-2 border-(--vscode-widget-border) pl-2 whitespace-pre-wrap text-(--vscode-descriptionForeground) italic">{part.text}</p>
								{/if}
							</div>
						{:else if part.kind === 'tool'}
							{#if !(part.id && hiddenTools(turn.parts, run?.decisions ?? {}).has(part.id))}
								<ChatToolRow {part} turnDone={turn.done} {cwd} {root} {chatId} pending={pendingTools(turn.parts)} onimplement={last ? actions.implement : undefined} />
							{/if}
						{:else if part.kind === 'confirmation'}
							{@const ev = part.request}
							{@const decided = run?.decisions[ev.request_id]}
							{#if part.reason}
								<div class="flex items-start gap-1.5 text-xs text-(--vscode-editorWarning-foreground)" role="note">
									<span class="mt-px shrink-0"><Icon name="warning" size={12} /></span><span class="min-w-0 break-words">{part.reason}</span>
								</div>
							{/if}
							{#if decided}
								<!-- A skipped call is a quiet line ("Skipped rm", Cursor's). -->
								<div class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)">
									{#if isAsk(ev)}<Icon name="circleDashed" size={13} />{/if}
									<span class="truncate">{isAsk(ev) ? t('chatView.questionDismissed') : skippedText(ev.tool, ev.input)}</span>
								</div>
							{:else if onanswer && !run?.ended && isAsk(ev) && parseAsk(ev.input)}
								{@const ask = parseAsk(ev.input)!}
								<QuestionCard prompt={ask} onsubmit={(sels) => onanswer(ev, 'allow', undefined, answersFor(ask, sels))} ondismiss={() => onanswer(ev, 'deny')} />
							{:else if onanswer && !run?.ended}
								<PermissionCard request={ev} keys={!!chatId} runMode={actions.runMode} {cwd} onanswer={(decision, message) => onanswer(ev, decision, message)} />
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
						{:else if part.kind === 'artifact'}
							<ArtifactCard artifact={part.artifact} />
						{:else if part.kind === 'mcpRequest'}
							{@const req = part.request}
							<McpRequestCard request={req} action={part.action} onanswer={chatId && !run?.ended ? (a, content, remember) => mcpChat.answer(chatId, req, a, content, remember) : undefined} />
						{:else if part.kind === 'canceled'}
							<div class="flex items-center gap-2">
								<span class="text-(--vscode-descriptionForeground) italic">{t('chatView.canceled')}</span>
								{#if last && pi === turn.parts.length - 1 && canContinue}
									<button
										type="button"
										class="flex items-center gap-1 rounded-md border border-(--vscode-widget-border) px-1.5 py-0.5 text-xs hover:bg-(--vscode-toolbar-hoverBackground)"
										title={t('chatTranscript.continueHint')}
										onclick={() => actions.continue?.()}><Icon name="play" size={11} />{t('chatTranscript.continue')}</button
									>
								{/if}
							</div>
						{/if}
					{/each}

					{#if !turn.done && showsProgress(turn.parts)}
						<div class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)" role="status">
							<span class="animate-pulse"><span class="font-semibold">{splitVerb(t('composer.progress.planning')).verb}</span> {splitVerb(t('composer.progress.planning')).rest}</span>
						</div>
					{/if}

					{#if turn.done && turn.request && turn.parts.length}
						{@const text = responseText(turn)}
						<div class="flex items-center gap-0.5">
							{#if text}
								<button type="button" class={ACTION} title={t('chatView.copyResponse')} aria-label={t('chatView.copyResponse')} onclick={() => copy(text, ti)}>
									<Icon name={copied === ti ? 'check' : 'copy'} size={13} />
								</button>
							{/if}
							{#if actions.fork && turn.checkpoint != null}
								{@const cp = turn.checkpoint}
								<button type="button" class={ACTION} title={t('chatRewind.forkHint')} aria-label={t('chatRewind.fork')} onclick={() => actions.fork?.(cp)}><Icon name="branch" size={13} /></button>
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
							{#if turn.checkpoint != null && actions.sentAt?.(turn.checkpoint)}
								<span class="ml-1 text-xs text-(--vscode-descriptionForeground)">{timeAgo(actions.sentAt(turn.checkpoint)!, Date.now())}</span>
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
