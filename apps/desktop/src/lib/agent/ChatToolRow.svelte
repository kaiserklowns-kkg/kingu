<script lang="ts">
	// One tool call of a response. Most are a one-line row ("Read src/x.ts") that expands to the
	// input and output. Edits are file pills with `+/−` that open the diff (ChatEditPill); TodoWrite
	// is a compact "Updated todos" (the list itself is the bar above the input); ExitPlanMode is
	// its plan as a card; a Task/Agent call holds its subagent's own text, thinking and tool calls,
	// collapsed, with their count and pending approvals (VS Code's chatSubagentContentPart).
	// A plan card offers Implement (`onimplement`, VS Code's plan review handoff). Bash shows its
	// command in a terminal-styled block with the output under it (chatTerminalToolProgressPart).
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import ChatMarkdown from './ChatMarkdown.svelte';
	import ChatEditPill from './ChatEditPill.svelte';
	import ChatToolRow from './ChatToolRow.svelte';
	import { editOf, isSubagentTool, planOf, subagentStats, toolLabel, type ToolPart } from './chatParts';

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

	let open = $state(false);
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
		<span class="shrink-0 text-(--vscode-errorForeground)"><Icon name="error" size={13} /></span>
	{:else}
		<span class="shrink-0 text-(--vscode-charts-green,#73C991)"><Icon name="check" size={13} /></span>
	{/if}
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
		<span class="min-w-0 flex-1 truncate">{done ? t('chatParts.todos.updated') : t('chatParts.todos.updating')}</span>
	</div>
{:else if plan}
	<div class="overflow-hidden rounded border border-(--vscode-widget-border)">
		<div class="flex h-7 items-center gap-1.5 border-b border-(--vscode-widget-border) bg-(--vscode-sideBar-background) px-2 font-semibold">
			<Icon name="listChecks" size={14} />
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
	<div class="flex flex-col gap-1">
		<ChatEditPill path={edit.path} added={edit.added} removed={edit.removed} {done} error={!!part.result?.isError} {chatId} {cwd} {root} />
		{#if part.result?.isError}
			<pre class={[PRE, 'font-mono text-(--vscode-errorForeground)']}>{part.result.content}</pre>
		{/if}
	</div>
{:else if subagent && stats}
	<div>
		<button
			type="button"
			class="flex w-full min-w-0 items-center gap-1.5 text-left text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			{@render statusIcon()}
			<span class="min-w-0 flex-1 truncate">{toolLabel(part.name, part.input, done, cwd)}</span>
			{#if waiting}
				<span class="shrink-0 text-(--vscode-editorWarning-foreground)">{t('chatParts.subagent.pending', { count: waiting })}</span>
			{:else if stats.tools}
				<span class="shrink-0 text-xs">{t('chatParts.subagent.tools', { count: stats.tools })}</span>
			{/if}
			<Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
		</button>
		{#if open}
			<div class="mt-1 ml-[5px] flex flex-col gap-1.5 border-l-2 border-(--vscode-widget-border) pl-3">
				{#if typeof prompt === 'string' && prompt.trim()}
					<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatParts.subagent.prompt')}</div>
					<p class="max-h-32 overflow-auto whitespace-pre-wrap text-(--vscode-descriptionForeground)">{prompt}</p>
				{/if}
				{#each part.children ?? [] as child, ci (ci)}
					{#if child.kind === 'markdown'}
						<ChatMarkdown text={child.text} {root} />
					{:else if child.kind === 'thinking'}
						<div>
							<button type="button" class="flex items-center gap-1 text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)" aria-expanded={!!openThoughts[ci]} onclick={() => (openThoughts[ci] = !openThoughts[ci])}>
								<Icon name={openThoughts[ci] ? 'chevronDown' : 'chevronRight'} size={12} />
								{t('chatView.thought')}
							</button>
							{#if openThoughts[ci]}
								<p class="mt-1 border-l-2 border-(--vscode-widget-border) pl-2 whitespace-pre-wrap text-(--vscode-descriptionForeground) italic">{child.text}</p>
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
	<div class="flex flex-col gap-1">
		<div class="flex min-w-0 items-center gap-1.5 text-(--vscode-descriptionForeground)">
			{@render statusIcon()}
			<span class="min-w-0 flex-1 truncate">{toolLabel(part.name, part.input, done, cwd)}</span>
		</div>
		<div class="overflow-hidden rounded border border-(--vscode-widget-border) bg-(--vscode-terminal-background,var(--vscode-editor-background)) font-mono text-xs text-(--vscode-terminal-foreground,var(--vscode-foreground))">
			<div class="flex items-start gap-1.5 px-2 py-1">
				<span class="shrink-0 text-(--vscode-terminal-ansiGreen,#73C991)" aria-hidden="true">$</span>
				<pre class="min-w-0 flex-1 break-all whitespace-pre-wrap">{bash}</pre>
				{#if part.result?.content}
					<button
						type="button"
						class="grid size-4 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
						aria-expanded={open}
						aria-label={open ? t('chatIo.terminalHide') : t('chatIo.terminalShow')}
						title={open ? t('chatIo.terminalHide') : t('chatIo.terminalShow')}
						onclick={() => (open = !open)}><Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} /></button
					>
				{/if}
			</div>
			{#if part.result}
				<pre
					class={[
						'overflow-auto border-t border-(--vscode-widget-border) px-2 py-1 break-all whitespace-pre-wrap',
						open ? 'max-h-96' : 'max-h-24',
						part.result.isError && 'text-(--vscode-errorForeground)'
					]}>{part.result.content || t('chatView.toolNoOutput')}</pre>
			{/if}
		</div>
	</div>
{:else}
	<div>
		<button
			type="button"
			class="flex w-full min-w-0 items-center gap-1.5 text-left text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			{@render statusIcon()}
			<span class="min-w-0 flex-1 truncate">{toolLabel(part.name, part.input, done, cwd)}</span>
			<Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
		</button>
		{#if open}{@render details()}{/if}
	</div>
{/if}
