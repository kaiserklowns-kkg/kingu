<script lang="ts">
	// A pending permission request, like VS Code's tool confirmation: Allow Once with a split menu
	// of approval scopes (Allow in this Session / in this Workspace / Always Allow, VS Code's
	// languageModelToolsConfirmationService), and Deny with an optional reason. The menu shows the
	// rule an "always" answer saves (the SDK's suggestion, e.g. `Bash(npm test:*)`). Shared by the
	// Agent panel and the ADE task page (through ChatList).
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { t } from '#lib/i18n/index.ts';
	import type { Decision, PermissionRequest } from './events';

	let { request, onanswer }: { request: PermissionRequest; onanswer: (decision: Decision, message?: string) => void } = $props();

	let reason = $state('');
	let sent = $state(false);
	let menu = $state<{ x: number; y: number; keyboard: boolean } | null>(null);

	function answer(decision: Decision) {
		if (sent) return;
		sent = true;
		onanswer(decision, decision === 'deny' ? reason : undefined);
		// The card goes away on `permission_resolved`; re-enable if that never comes (e.g. the call failed).
		setTimeout(() => (sent = false), 3000);
	}

	const rule = $derived(request.rules?.length ? t('chatInput.perm.rules', { rules: request.rules.join(', ') }) : t('chatInput.perm.wholeTool', { tool: request.tool }));
	const scopes = $derived<MenuNode[]>([
		menuItem('allow', t('chatInput.perm.allowOnce')),
		menuSeparator,
		menuItem('allow_always', t('chatInput.perm.session')),
		menuItem('allow_workspace', t('chatInput.perm.workspace')),
		menuItem('allow_user', t('chatInput.perm.user'))
	]);

	function openMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		// Above the button (4 rows, a separator, padding), so the scope notes below stay readable.
		menu = { x: r.left, y: Math.max(4, r.top - 4 * 26 - 9 - 12), keyboard: e.detail === 0 };
	}

	const BTN = 'rounded-sm px-2 py-0.5 disabled:opacity-50';
	const PRIMARY = 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)';
	const SECONDARY = 'bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)';
</script>

<div
	class="space-y-1.5 rounded border border-(--vscode-editorWarning-foreground)/60 bg-(--vscode-editorWidget-background) p-2 text-(--vscode-foreground)"
	role="group"
	aria-label={t('chatView.permission.title', { tool: request.tool })}
>
	<div class="font-medium">{t('chatView.permission.title', { tool: request.tool })}</div>
	{#if request.title}<div class="text-(--vscode-descriptionForeground)">{request.title}</div>{/if}
	{#if request.input_summary}
		{#if request.tool === 'Bash'}<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatInput.perm.command')}</div>{/if}
		<pre class="max-h-32 overflow-auto rounded border border-(--vscode-widget-border) px-2 py-1 font-mono break-all whitespace-pre-wrap">{request.input_summary}</pre>
	{/if}
	{#if request.diff}
		<div class="font-mono">
			<span class="text-(--vscode-gitDecoration-addedResourceForeground,#81b88b)">+{request.diff.added}</span>
			<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#c74e39)">−{request.diff.removed}</span>
			{t('chatView.permission.lines')}
		</div>
	{/if}
	{#if request.detail}<div class="text-(--vscode-descriptionForeground)">{request.detail}</div>{/if}
	<input
		class="w-full rounded-sm border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 py-0.5 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
		placeholder={t('chatView.permission.reason')}
		aria-label={t('chatView.permission.reason')}
		bind:value={reason}
	/>
	<div class="flex flex-wrap items-center gap-1.5">
		<span class="flex">
			<button class={[BTN, PRIMARY, request.can_always && 'rounded-r-none']} title={t('chatView.permission.allowHint')} disabled={sent} onclick={() => answer('allow')}
				>{t('chatInput.perm.allowOnce')}</button
			>
			{#if request.can_always}
				<button
					class={[BTN, PRIMARY, 'rounded-l-none border-l border-(--vscode-button-foreground)/30 px-1']}
					aria-label={t('chatInput.perm.more')}
					title={t('chatInput.perm.more')}
					aria-haspopup="menu"
					aria-expanded={menu !== null}
					disabled={sent}
					onclick={openMenu}><Icon name="chevronDown" size={12} /></button
				>
			{/if}
		</span>
		<button class={[BTN, SECONDARY]} disabled={sent} onclick={() => answer('deny')}>{t('chatView.permission.deny')}</button>
		{#if request.can_always}<span class="min-w-0 truncate text-xs text-(--vscode-descriptionForeground)" title={rule}>{rule}</span>{/if}
	</div>
	{#if menu}
		<div class="text-xs text-(--vscode-descriptionForeground)">
			<div>{t('chatInput.perm.session')}: {t('chatInput.perm.sessionHint')}</div>
			<div>{t('chatInput.perm.workspace')}: {t('chatInput.perm.workspaceHint')}</div>
			<div>{t('chatInput.perm.user')}: {t('chatInput.perm.userHint')}</div>
		</div>
		<PopupMenu items={scopes} label={t('chatInput.perm.more')} x={menu.x} y={menu.y} focusFirst={menu.keyboard} onRun={(n) => n.type === 'item' && answer(n.id as Decision)} onClose={() => (menu = null)} />
	{/if}
</div>
