<script lang="ts">
	// A pending permission request, laid out like Cursor's inline command approval: a quiet
	// "Pending approval" line, then the card. A shell call's header is its description and the
	// command names it runs ("›_ Write probe2.txt and print it  echo, cat"), over the command with
	// shell colours; an edit is Cursor's edit card (the file's icon, its path in the workspace,
	// +/− and a few lines of the diff); other tools show their title, input and +/− lines. The bottom row: "Allowlist ⌄"
	// on the left (the chat's run mode, "Change run mode", and under a separator the ways to always
	// allow this call: in this folder, this session, every folder), then VS Code's "Always allow
	// `npm test …`" / "Always allow docs.rs" when Rust offers a rule, Skip and Run on the right. In the
	// Agent panel the composer answers it too while its input is empty: ⏎ Run, ⇧⏎ allow in this
	// folder, Esc Skip (`keys` shows them). Shared by the Agent panel and the ADE task page (through ChatList).
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { Decision, PermissionRequest } from './events';
	import type { AgentApproval } from './chatInput.ts';
	import ComposerMenu from './ComposerMenu.svelte';
	import type { MenuRow } from './composerMenu.ts';
	import { commandNames, runModeHint, runModeLabel, shellTokens, type ShellToken } from './composer.ts';
	import { bashDescription, editOf, editSnippet, shortPath } from './chatParts.ts';
	import FileIcon from '#lib/workbench/FileIcon.svelte';
	import { fileIcon } from '#lib/workbench/fileIcons.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { suggestionLabel, usableSuggestion, withRule } from './toolRules.ts';

	/** The chat's run mode, changed from the card's Allowlist menu (the Agent panel's chats). */
	export type RunModeControl = { current: AgentApproval; options: readonly AgentApproval[]; pick: (a: AgentApproval) => void; locked?: boolean };

	let {
		request,
		onanswer,
		keys = false,
		runMode,
		cwd = null
	}: {
		request: PermissionRequest;
		onanswer: (decision: Decision, message?: string) => void;
		keys?: boolean;
		runMode?: RunModeControl;
		/** Where the agent runs: an edit's path is shown relative to it. */
		cwd?: string | null;
	} = $props();

	let sent = $state(false);
	let menuOpen = $state(false);

	function answer(decision: Decision) {
		if (sent) return;
		sent = true;
		onanswer(decision);
		// The card goes away on `permission_resolved`; re-enable if that never comes (e.g. the call failed).
		setTimeout(() => (sent = false), 3000);
	}

	const command = $derived(request.tool === 'Bash' && request.input_summary ? request.input_summary : null);
	const description = $derived(bashDescription(request.input));
	const names = $derived(command ? commandNames(command).join(', ') : '');
	const tokens = $derived(command ? shellTokens(command) : []);
	const edit = $derived(editOf(request.tool, request.input));
	const editPath = $derived(edit ? shortPath(edit.path, cwd) : '');
	const snippet = $derived(edit ? editSnippet(request.tool, request.input, 8) : []);
	const rule = $derived(request.rules?.length ? t('chatInput.perm.rules', { rules: request.rules.join(', ') }) : t('chatInput.perm.wholeTool', { tool: request.tool }));
	const rows = $derived<MenuRow[]>([
		...(runMode
			? runMode.options.map((a) => ({
					id: `run:${a}`,
					label: runModeLabel(a),
					description: runModeHint(a),
					section: t('composer.approve.changeRunMode'),
					checked: a === runMode.current,
					disabled: runMode.locked,
					warn: a === 'bypassPermissions'
				}))
			: []),
		...(request.can_always
			? [
					{ id: 'allow_workspace', label: t('chatInput.perm.workspace'), description: rule, section: t('composer.approve.allowCall') },
					{ id: 'allow_always', label: t('chatInput.perm.session'), description: t('chatInput.perm.sessionHint'), section: t('composer.approve.allowCall') },
					{ id: 'allow_user', label: t('chatInput.perm.user'), description: t('chatInput.perm.userHint'), section: t('composer.approve.allowCall') }
				]
			: [])
	]);

	// VS Code's "Always allow `npm test …`" / "Always allow docs.rs": the rule Rust offers
	// (agent/tool_rules) goes to the user's chat.tools.terminal/urls.autoApprove, then this call runs.
	const suggestion = $derived(usableSuggestion(request.auto_approve));
	const suggested = $derived(suggestion ? suggestionLabel(suggestion) : null);
	let ruleError = $state<string | null>(null);

	async function allowAlways() {
		if (sent || !suggestion) return;
		ruleError = null;
		try {
			await settings.set(suggestion.setting, withRule(settings.userValue(suggestion.setting), suggestion), 'user');
		} catch (e) {
			ruleError = t('chatToolRules.saveFailed', { error: e instanceof Error ? e.message : String(e) });
			return;
		}
		answer('allow');
	}

	function pick(id: string) {
		menuOpen = false;
		if (id.startsWith('run:')) runMode?.pick(id.slice(4) as AgentApproval);
		else answer(id as Decision);
	}

	const COLOR: Record<ShellToken['kind'], string | undefined> = {
		cmd: 'var(--vscode-charts-orange, #d18616)',
		op: 'var(--vscode-charts-blue, #3794ff)',
		str: 'var(--vscode-charts-green, #89d185)',
		arg: undefined,
		space: undefined
	};
	const BTN = 'inline-flex h-[22px] items-center gap-1 rounded-md px-2 disabled:opacity-50';
	const KEY = 'text-[10px] opacity-70';
</script>

<div class="flex flex-col gap-1">
	<div class="text-(--vscode-descriptionForeground)" role="status">{t('composer.approve.pending')}</div>
	<div class="rounded-[8px] border border-(--vscode-chat-requestBorder) bg-(--vscode-editorWidget-background) text-xs text-(--vscode-foreground)" role="group" aria-label={t('chatView.permission.title', { tool: request.tool })}>
		{#if command !== null}
			<div class="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5" title={command}>
				<span class="shrink-0 font-mono text-(--vscode-descriptionForeground)" aria-hidden="true">›_</span>
				<span class="min-w-0 truncate">{description ?? request.title ?? t('chatView.permission.title', { tool: request.tool })}</span>
				{#if names}<span class="min-w-0 shrink-0 truncate text-(--vscode-descriptionForeground)">{names}</span>{/if}
			</div>
			<pre class="max-h-40 overflow-auto border-y border-(--vscode-widget-border) bg-(--vscode-textCodeBlock-background,var(--vscode-editor-background)) px-2.5 py-1.5 font-mono break-all whitespace-pre-wrap"><span class="text-(--vscode-descriptionForeground) select-none">$ </span>{#each tokens as tok, i (i)}<span style:color={COLOR[tok.kind]}>{tok.text}</span>{/each}</pre>
		{:else if edit}
			<div class="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5" title={editPath}>
				<FileIcon icon={fileIcon(editPath.split('/').pop() ?? editPath)} size={14} />
				<span class="min-w-0 truncate">{editPath}</span>
				<span class="shrink-0 font-mono text-[11px]"
					><span class="text-(--vscode-gitDecoration-addedResourceForeground,#73c991)">+{edit.added}</span>
					{#if edit.removed}<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)">−{edit.removed}</span>{/if}</span
				>
			</div>
			{#if snippet.length}
				<pre class="max-h-40 overflow-auto border-y border-(--vscode-widget-border) py-0.5 font-mono leading-[18px]">{#each snippet as line, li (li)}<div
							class={[
								'px-2.5 whitespace-pre',
								line.sign === '+' && 'bg-(--vscode-diffEditor-insertedLineBackground,rgba(115,201,145,0.15))',
								line.sign === '-' && 'bg-(--vscode-diffEditor-removedLineBackground,rgba(241,76,76,0.15))',
								line.sign === ' ' && 'text-(--vscode-descriptionForeground)'
							]}><span class="mr-2 inline-block w-2 opacity-70 select-none">{line.sign === ' ' ? '' : line.sign}</span>{line.text || ' '}</div>{/each}</pre>
			{:else}
				<div class="border-b border-(--vscode-widget-border)"></div>
			{/if}
		{:else}
			<div class="space-y-1.5 border-b border-(--vscode-widget-border) px-2.5 py-1.5">
				<div class="flex items-center gap-1.5 font-medium">
					<Codicon id="shield" size={13} />
					<span class="min-w-0 truncate">{t('chatView.permission.title', { tool: request.tool })}</span>
				</div>
				{#if request.title}<div class="text-(--vscode-descriptionForeground)">{request.title}</div>{/if}
				{#if request.input_summary}
					<pre class="max-h-32 overflow-auto rounded-md bg-(--vscode-textCodeBlock-background,var(--vscode-input-background)) px-2 py-1 font-mono break-all whitespace-pre-wrap">{request.input_summary}</pre>
				{/if}
				{#if request.diff}
					<div class="font-mono">
						<span class="text-(--vscode-gitDecoration-addedResourceForeground,#81b88b)">+{request.diff.added}</span>
						<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#c74e39)">−{request.diff.removed}</span>
						{t('chatView.permission.lines')}
					</div>
				{/if}
				{#if request.detail}<div class="text-(--vscode-descriptionForeground)">{request.detail}</div>{/if}
			</div>
		{/if}
		<div class="flex items-center gap-1.5 px-2 py-1.5">
			{#if rows.length}
				<div class="relative flex min-w-0">
					<button
						class={[BTN, 'min-w-0 text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)']}
						title={t('composer.approve.changeRunMode')}
						aria-haspopup="listbox"
						aria-expanded={menuOpen}
						disabled={sent}
						onclick={() => (menuOpen = !menuOpen)}
						><span class="truncate">{runMode ? runModeLabel(runMode.current) : t('composer.approve.allowlist')}</span><Codicon id="chevron-down" size={10} />{#if keys && request.can_always}<span class={KEY}>⇧⏎</span>{/if}</button
					>
					{#if menuOpen}
						<ComposerMenu {rows} label={t('composer.approve.changeRunMode')} width={300} onpick={pick} onclose={() => (menuOpen = false)} />
					{/if}
				</div>
			{/if}
			<span class="flex-1"></span>
			{#if suggested}
				<button
					class={[BTN, 'min-w-0 border border-(--vscode-button-border,var(--vscode-widget-border)) text-(--vscode-foreground) hover:bg-(--vscode-toolbar-hoverBackground)']}
					title={suggested.hint}
					disabled={sent}
					onclick={() => void allowAlways()}><span class="truncate">{suggested.label}</span></button
				>
			{/if}
			<button class={[BTN, 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)']} title={t('composer.approve.skipHint')} disabled={sent} onclick={() => answer('deny')}
				>{t('composer.approve.skip')}{#if keys}<span class={KEY}>Esc</span>{/if}</button
			>
			<button
				class={[BTN, 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)']}
				title={t('chatView.permission.allowHint')}
				disabled={sent}
				onclick={() => answer('allow')}>{t('composer.approve.run')}{#if keys}<span class={KEY}>⏎</span>{/if}</button
			>
		</div>
		{#if ruleError}<div class="px-2.5 pb-1.5 text-(--vscode-errorForeground)" role="alert">{ruleError}</div>{/if}
	</div>
</div>
