<script lang="ts" module>
	import type { ChatView, Turn } from './chatParts';

	export type ChatListActions = {
		/** Sends the last request again. */
		retry?: () => void;
		/** Puts a request back in the input to change and send as a new message. */
		edit?: (request: NonNullable<Turn['request']>) => void;
	};
</script>

<script lang="ts">
	// A run as VS Code's chat list (chatListRenderer): each request, then its response made of
	// parts: markdown with code block actions, thinking (collapsed), tool calls as one-line rows
	// that expand to their input and output, approval and question cards, errors with Retry, and a
	// "Working…" row while the turn runs. Internal events are not shown (chatParts.ts). Shared by
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
	import { answersFor, parseAsk } from './ask';
	import { buildTurns, responseText, toolLabel, type Part, type ToolPart } from './chatParts';
	import { contextLabel } from './chatPrompt';
	import { formatUsage, type Decision, type PermissionRequest } from './events';

	let {
		run,
		onanswer,
		actions = {},
		cwd = null,
		root = null,
		empty,
		checkpoint,
		reverted,
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
		/** Chat edits: an action on each request (Restore checkpoint), given its request index. */
		checkpoint?: Snippet<[number]>;
		/** Chat edits: whether a request was reverted by a restored checkpoint (dimmed, like VS Code). */
		reverted?: (request: number) => boolean;
		class?: string;
	} = $props();

	let list: HTMLDivElement;
	/** Follow new output while the list is scrolled to the bottom (VS Code's scroll lock). */
	let stick = true;
	const look = $derived(chatLook((id) => settings.get(id)));
	const turns = $derived(run ? buildTurns(run) : []);
	let open = $state<Record<string, boolean>>({});
	let copied = $state<number | null>(null);

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
	const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
	/** The part that shows the turn is busy: no spinner under a streaming text or an open question. */
	const showsProgress = (parts: Part[]) => {
		const last = parts[parts.length - 1];
		return !(last && ((last.kind === 'markdown' && last.streaming) || last.kind === 'confirmation'));
	};
	const toolInput = (tool: ToolPart) => {
		const o = tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : null;
		if (tool.name === 'Bash' && typeof o?.command === 'string') return o.command;
		return pretty(tool.input);
	};
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
				{@const dim = turn.checkpoint != null && !!reverted?.(turn.checkpoint)}
				<div class={['flex flex-col gap-3', dim && 'opacity-50']}>
				{#if turn.request}
					{@const req = turn.request}
					<!-- Request -->
					<div class="group/req flex flex-col items-end gap-1">
						<div class="max-w-[90%] rounded-lg bg-(--vscode-chat-requestBackground,var(--vscode-input-background)) px-2.5 py-1.5 break-words whitespace-pre-wrap">
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
						<div class="flex gap-0.5 opacity-0 transition-opacity group-hover/req:opacity-100 focus-within:opacity-100">
							{#if actions.edit}
								<button type="button" class={ACTION} title={t('chatView.editRequest')} aria-label={t('chatView.editRequest')} onclick={() => actions.edit?.(req)}><Icon name="edit" size={13} /></button>
							{/if}
							<button type="button" class={ACTION} title={t('chatView.copyRequest')} aria-label={t('chatView.copyRequest')} onclick={() => copy(req.text, -1 - ti)}>
								<Icon name={copied === -1 - ti ? 'check' : 'copy'} size={13} />
							</button>
							{#if checkpoint && turn.checkpoint != null}{@render checkpoint(turn.checkpoint)}{/if}
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
							{@const done = !!part.result || turn.done}
							<div>
								<button
									type="button"
									class="flex w-full min-w-0 items-center gap-1.5 text-left text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
									aria-expanded={!!open[key]}
									onclick={() => toggle(key)}
								>
									{#if !done}
										<span class="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>
									{:else if part.result?.isError}
										<span class="shrink-0 text-(--vscode-errorForeground)"><Icon name="error" size={13} /></span>
									{:else}
										<span class="shrink-0 text-(--vscode-charts-green,#73C991)"><Icon name="check" size={13} /></span>
									{/if}
									<span class="min-w-0 flex-1 truncate">{toolLabel(part.name, part.input, done, cwd)}</span>
									<Icon name={open[key] ? 'chevronDown' : 'chevronRight'} size={12} />
								</button>
								{#if open[key]}
									<div class="mt-1 ml-[18px] space-y-1 font-mono">
										<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatView.toolInput')}</div>
										<pre class="max-h-48 overflow-auto rounded border border-(--vscode-widget-border) px-2 py-1 break-all whitespace-pre-wrap">{toolInput(part)}</pre>
										{#if part.result}
											<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatView.toolOutput')}</div>
											<pre
												class={[
													'max-h-64 overflow-auto rounded border border-(--vscode-widget-border) px-2 py-1 break-all whitespace-pre-wrap',
													part.result.isError && 'text-(--vscode-errorForeground)'
												]}>{part.result.content || t('chatView.toolNoOutput')}</pre>
										{/if}
									</div>
								{/if}
							</div>
						{:else if part.kind === 'confirmation'}
							{@const ev = part.request}
							{@const decided = run?.decisions[ev.request_id]}
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
							{#if turn.result && formatUsage(turn.result)}
								<span class={[ACTION, 'cursor-default']} title={t('chatView.usage', { usage: formatUsage(turn.result) })} aria-label={t('chatView.usage', { usage: formatUsage(turn.result) })}>
									<Icon name="info" size={13} />
								</span>
							{/if}
						</div>
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
