<script lang="ts">
	// A pending permission request, laid out like Cursor's inline command approval: a quiet
	// "Pending approval" line, then the card. A shell call's header is its description and the
	// command names it runs ("›_ Write probe2.txt and print it  echo, cat"), over the command with
	// shell colours; other tools show their title, input and +/− lines. The bottom row: "Allowlist ⌄"
	// on the left (the chat's run mode, "Change run mode", and under a separator the ways to always
	// allow this call: in this folder, this session, every folder), Skip and Run on the right. In the
	// Agent panel the composer answers it too while its input is empty: ⏎ Run, ⇧⏎ allow in this
	// folder, Esc Skip (`keys` shows them). Shared by the Agent panel and the ADE task page (through ChatList).
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { Decision, PermissionRequest } from './events';
	import type { AgentApproval } from './chatInput.ts';
	import ComposerMenu from './ComposerMenu.svelte';
	import type { MenuRow } from './composerMenu.ts';
	import { commandNames, runModeHint, runModeLabel, shellTokens, type ShellToken } from './composer.ts';
	import { bashDescription } from './chatParts.ts';

	/** The chat's run mode, changed from the card's Allowlist menu (the Agent panel's chats). */
	export type RunModeControl = { current: AgentApproval; options: readonly AgentApproval[]; pick: (a: AgentApproval) => void; locked?: boolean };

	let {
		request,
		onanswer,
		keys = false,
		runMode
	}: { request: PermissionRequest; onanswer: (decision: Decision, message?: string) => void; keys?: boolean; runMode?: RunModeControl } = $props();

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
	<div class="rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) text-xs text-(--vscode-foreground)" role="group" aria-label={t('chatView.permission.title', { tool: request.tool })}>
		{#if command !== null}
			<div class="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5" title={command}>
				<span class="shrink-0 font-mono text-(--vscode-descriptionForeground)" aria-hidden="true">›_</span>
				<span class="min-w-0 truncate">{description ?? request.title ?? t('chatView.permission.title', { tool: request.tool })}</span>
				{#if names}<span class="min-w-0 shrink-0 truncate text-(--vscode-descriptionForeground)">{names}</span>{/if}
			</div>
			<pre class="max-h-40 overflow-auto border-y border-(--vscode-widget-border) bg-(--vscode-textCodeBlock-background,var(--vscode-editor-background)) px-2.5 py-1.5 font-mono break-all whitespace-pre-wrap"><span class="text-(--vscode-descriptionForeground) select-none">$ </span>{#each tokens as tok, i (i)}<span style:color={COLOR[tok.kind]}>{tok.text}</span>{/each}</pre>
		{:else}
			<div class="space-y-1.5 border-b border-(--vscode-widget-border) px-2.5 py-1.5">
				<div class="flex items-center gap-1.5 font-medium">
					<Icon name="shield" size={13} />
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
						><span class="truncate">{runMode ? runModeLabel(runMode.current) : t('composer.approve.allowlist')}</span><Icon name="chevronDown" size={10} />{#if keys && request.can_always}<span class={KEY}>⇧⏎</span>{/if}</button
					>
					{#if menuOpen}
						<ComposerMenu {rows} label={t('composer.approve.changeRunMode')} width={300} onpick={pick} onclose={() => (menuOpen = false)} />
					{/if}
				</div>
			{/if}
			<span class="flex-1"></span>
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
	</div>
</div>
