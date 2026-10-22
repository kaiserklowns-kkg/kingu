<script lang="ts">
	// One tool call of a response. Most are a one-line row ("Read src/x.ts") that expands to the
	// input and output. Edits are file pills with `+/−` that open the diff (ChatEditPill); TodoWrite
	// is a compact "Updated todos" (the list itself is the bar above the input); ExitPlanMode is
	// its plan as a card; a Task/Agent call holds its subagent's own text, thinking and tool calls,
	// collapsed, with their count and pending approvals (VS Code's chatSubagentContentPart).
	// A plan card offers Implement (`onimplement`, VS Code's plan review handoff). Bash shows its
	// command in a terminal-styled block with the output under it (chatTerminalToolProgressPart).
	// Cursor's look: most calls are quiet one-liners with the verb in bold ("**Read** app.js"); a
	// shell call is a bordered card ("›_ Show git status  git" over its output); an edit is a
	// bordered card with the file, +N and a few lines of its diff. A failed call opens by itself
	// (chat.tools.autoExpandFailures); one the auto-approve rules let run says by which rule.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { codiconOf } from './chatIcons.ts';
	import { t } from '#lib/i18n/index.ts';
	import ChatMarkdown from './ChatMarkdown.svelte';
	import ChatEditPill from './ChatEditPill.svelte';
	import ChatToolRow from './ChatToolRow.svelte';
	import { bashDescription, editOf, editSnippet, isSubagentTool, planOf, splitVerb, subagentStats, toolLabel, type ToolPart } from './chatParts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { approvedByText } from './toolRules.ts';

	let {
		part,
		turnDone,
		cwd = null,
		root = null,
		chatId = null,
		pending = new Set(),
		onimplement
	}: {
		part: ToolPart;
		/** The turn ended: a call without a result is over too. */
		turnDone: boolean;
		cwd?: string | null;
		root?: string | null;
		chatId?: string | null;
		/** Tool call ids waiting for the user's approval (the subagent row counts its own). */
		pending?: ReadonlySet<string>;
		/** The plan card's Implement button (only on the last turn's plan, in plan mode). */
		onimplement?: () => void;
	} = $props();

	// chat.tools.autoExpandFailures: a failed call opens by itself until the user folds it.
	let toggled = $state<boolean | null>(null);
	const open = $derived(toggled ?? (settings.get<boolean>('chat.tools.autoExpandFailures') !== false && !!part.result?.isError));
	const toggle = () => (toggled = !open);
	const approvedBy = $derived(approvedByText(part.autoApproved));
	let openThoughts = $state<Record<number, boolean>>({});
	const done = $derived(!!part.result || turnDone);
	const edit = $derived(editOf(part.name, part.input));
	const plan = $derived(part.name === 'ExitPlanMode' ? planOf(part.input) : null);
	const subagent = $derived(isSubagentTool(part.name));
	const stats = $derived(subagent ? subagentStats(part) : null);
	const waiting = $derived(stats ? [...stats.ids].filter((id) => pending.has(id)).length : 0);
	const bash = $derived(part.name === 'Bash' && part.input && typeof part.input === 'object' && typeof (part.input as Record<string, unknown>).command === 'string' ? ((part.input as Record<string, unknown>).command as string) : null);
	const prompt = $derived(subagent && part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>).prompt : undefined);

	const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
	const toolInput = (tool: ToolPart) => {
		const o = tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : null;
		if (tool.name === 'Bash' && typeof o?.command === 'string') return o.command;
		return pretty(tool.input);
	};
	const PRE = 'max-h-48 overflow-auto rounded border border-(--vscode-widget-border) px-2 py-1 break-all whitespace-pre-wrap';
</script>

{#snippet statusIcon()}
	{#if !done}
		<span class="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"></span>
	{:else if part.result?.isError}
		<span class="shrink-0 text-(--vscode-errorForeground)"><Codicon id="error" size={13} /></span>
	{/if}
{/snippet}

{#snippet label(text: string)}
	{@const parts = splitVerb(text)}
	<span class="min-w-0 flex-1 truncate"><span class="font-semibold text-(--vscode-foreground)/85">{parts.verb}</span>{parts.rest ? ` ${parts.rest}` : ''}</span>
{/snippet}

{#snippet details()}
	<div class="mt-1 ml-[18px] space-y-1 font-mono">
		<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatView.toolInput')}</div>
		<pre class={PRE}>{toolInput(part)}</pre>
		{#if part.result}
			<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatView.toolOutput')}</div>
			<pre class={[PRE, 'max-h-64', part.result.isError && 'text-(--vscode-errorForeground)']}>{part.result.content || t('chatView.toolNoOutput')}</pre>
		{/if}
	</div>
{/snippet}

{#if part.name === 'TodoWrite' && !part.result?.isError}
	<div class="flex min-w-0 items-center gap-1.5 text-(--vscode-descriptionForeground)">
		{@render statusIcon()}
		{@render label(done ? t('chatParts.todos.updated') : t('chatParts.todos.updating'))}
	</div>
{:else if plan}
	<div class="overflow-hidden rounded border border-(--vscode-widget-border)">
		<div class="flex h-7 items-center gap-1.5 border-b border-(--vscode-widget-border) bg-(--vscode-sideBar-background) px-2 font-semibold">
			<Codicon id="checklist" size={14} />
			<span class="min-w-0 flex-1 truncate">{t('chatParts.plan.title')}</span>
			{#if onimplement}
				<button
					type="button"
					class="h-5 shrink-0 rounded-sm bg-(--vscode-button-background) px-2 text-xs font-normal text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)"
					title={t('chatIo.implementHint')}
					onclick={() => onimplement?.()}>{t('chatIo.implement')}</button
				>
			{/if}
		</div>
		<div class="px-3 py-2">
			<ChatMarkdown text={plan} {root} />
		</div>
	</div>
{:else if edit}
	{@const snippet = editSnippet(part.name, part.input)}
	<div class="overflow-hidden rounded-[8px] border border-(--vscode-chat-requestBorder)">
		<ChatEditPill path={edit.path} added={edit.added} removed={edit.removed} {done} error={!!part.result?.isError} {chatId} {cwd} {root} flat />
		{#if snippet.length && !part.result?.isError}
			<pre class="overflow-hidden border-t border-(--vscode-widget-border) py-0.5 font-mono text-xs leading-[18px]">{#each snippet as line, li (li)}<div
						class={[
							'truncate px-2',
							line.sign === '+' && 'bg-(--vscode-diffEditor-insertedLineBackground,rgba(115,201,145,0.15)) text-(--vscode-foreground)',
							line.sign === '-' && 'bg-(--vscode-diffEditor-removedLineBackground,rgba(241,76,76,0.15)) text-(--vscode-foreground)',
							line.sign === ' ' && 'text-(--vscode-descriptionForeground)'
						]}><span class="mr-2 inline-block w-2 opacity-70 select-none">{line.sign === ' ' ? '' : line.sign}</span>{line.text || ' '}</div>{/each}</pre>
		{/if}
		{#if part.result?.isError}
			<pre class="border-t border-(--vscode-widget-border) px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap text-(--vscode-errorForeground)">{part.result.content}</pre>
		{/if}
	</div>
{:else if subagent && stats}
	<div>
		<button
			type="button"
			class="chat-used-context-label w-full! text-left"
			aria-expanded={open}
			onclick={toggle}
		>
			{@render statusIcon()}
			{@render label(toolLabel(part.name, part.input, done, cwd))}
			{#if waiting}
				<span class="shrink-0 text-(--vscode-editorWarning-foreground)">{t('chatParts.subagent.pending', { count: waiting })}</span>
			{:else if stats.tools}
				<span class="shrink-0 text-xs">{t('chatParts.subagent.tools', { count: stats.tools })}</span>
			{/if}
			<Codicon id={open ? 'chevron-down' : 'chevron-right'} size={12} />
		</button>
		{#if open}
			<div class="chat-used-context-list mt-1 flex flex-col gap-1.5 whitespace-normal">
				{#if typeof prompt === 'string' && prompt.trim()}
					<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatParts.subagent.prompt')}</div>
					<p class="max-h-32 overflow-auto whitespace-pre-wrap text-(--vscode-descriptionForeground)">{prompt}</p>
				{/if}
				{#each part.children ?? [] as child, ci (ci)}
					{#if child.kind === 'markdown'}
						<ChatMarkdown text={child.text} {root} />
					{:else if child.kind === 'thinking'}
						<div>
							<button type="button" class="chat-used-context-label" aria-expanded={!!openThoughts[ci]} onclick={() => (openThoughts[ci] = !openThoughts[ci])}>
								<Codicon id={codiconOf(openThoughts[ci] ? 'chevronDown' : 'chevronRight')} size={12} />
								{t('chatView.thought')}
							</button>
							{#if openThoughts[ci]}
								<p class="chat-used-context-list mt-1">{child.text}</p>
							{/if}
						</div>
					{:else if child.kind === 'tool'}
						<ChatToolRow part={child} {turnDone} {cwd} {root} {chatId} {pending} />
					{/if}
				{/each}
				{#if part.result}
					<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatParts.subagent.result')}</div>
					<pre class={[PRE, 'max-h-64 font-mono', part.result.isError && 'text-(--vscode-errorForeground)']}>{part.result.content || t('chatView.toolNoOutput')}</pre>
				{/if}
			</div>
		{/if}
	</div>
{:else if bash !== null}
	{@const desc = bashDescription(part.input)}
	<div class="overflow-hidden rounded-[8px] border border-(--vscode-chat-requestBorder) text-xs">
		<button
			type="button"
			class="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left hover:bg-(--vscode-list-hoverBackground)"
			aria-expanded={open}
			title={bash}
			onclick={toggle}
		>
			{#if !done || part.result?.isError}{@render statusIcon()}{:else}<span class="shrink-0 font-mono text-(--vscode-descriptionForeground)" aria-hidden="true">›_</span>{/if}
			<span class="min-w-0 truncate text-(--vscode-foreground)">{desc ?? bash}</span>
			{#if desc}<span class="min-w-0 shrink-0 truncate font-mono text-(--vscode-descriptionForeground)">{bash.trim().split(/\s+/, 1)[0]}</span>{/if}
			<span class="flex-1"></span>
			{#if part.result?.content}<Codicon id={open ? 'chevron-up' : 'chevron-down'} size={12} />{/if}
		</button>
		<div class="border-t border-(--vscode-widget-border) bg-(--vscode-terminal-background,var(--vscode-editor-background)) font-mono text-(--vscode-terminal-foreground,var(--vscode-foreground))">
			{#if desc || open}<pre class="px-2 pt-1 break-all whitespace-pre-wrap text-(--vscode-descriptionForeground)">$ {bash}</pre>{/if}
			{#if part.result}
				<pre
					class={['overflow-auto px-2 py-1 break-all whitespace-pre-wrap', open ? 'max-h-96' : 'max-h-24', part.result.isError && 'text-(--vscode-errorForeground)']}
					aria-label={open ? t('chatIo.terminalHide') : t('chatIo.terminalShow')}>{part.result.content || t('chatView.toolNoOutput')}</pre>
			{:else if !desc && !open}
				<pre class="px-2 py-1 break-all whitespace-pre-wrap text-(--vscode-descriptionForeground)">$ {bash}</pre>
			{/if}
		</div>
		{#if approvedBy}<div class="truncate border-t border-(--vscode-widget-border) px-2 py-0.5 text-[11px] text-(--vscode-descriptionForeground)" title={approvedBy}>{approvedBy}</div>{/if}
	</div>
{:else}
	<div class="group/tool">
		<button
			type="button"
			class="chat-used-context-label w-full! text-left"
			aria-expanded={open}
			onclick={toggle}
		>
			{@render statusIcon()}
			{@render label(toolLabel(part.name, part.input, done, cwd))}
			<span class="opacity-0 group-hover/tool:opacity-100"><Codicon id={open ? 'chevron-down' : 'chevron-right'} size={12} /></span>
		</button>
		{#if approvedBy}<div class="ml-[18px] truncate text-[11px] text-(--vscode-descriptionForeground)" title={approvedBy}>{approvedBy}</div>{/if}
		{#if open}{@render details()}{/if}
	</div>
{/if}
