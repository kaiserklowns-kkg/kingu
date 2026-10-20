<script lang="ts">
	// A pending permission request, laid out like Cursor's inline command approval: the tool and
	// its command or change, then Skip · Allowlist ▾ · Run. Run allows this call once; the allowlist
	// button saves the rule an "always" answer adds (the SDK's suggestion, e.g. `Bash(npm test:*)`,
	// shown as `npm test *`) in this folder, and its ▾ offers the other scopes (this session, every
	// folder: VS Code's languageModelToolsConfirmationService scopes). Skip denies, with an optional
	// reason. In the Agent panel the composer answers it too while its input is empty: ⏎ Run,
	// ⇧⏎ allowlist, Esc Skip (`keys` shows them). Shared by the Agent panel and the ADE task page (through ChatList).
	import Icon from '#lib/workbench/Icon.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import type { MenuNode } from '#lib/workbench/menus.ts';
	import { t } from '#lib/i18n/index.ts';
	import type { Decision, PermissionRequest } from './events';
	import { allowlistLabel } from './composer.ts';

	let { request, onanswer, keys = false }: { request: PermissionRequest; onanswer: (decision: Decision, message?: string) => void; keys?: boolean } = $props();

	let reason = $state('');
	let reasonOpen = $state(false);
	let sent = $state(false);
	let menu = $state<{ x: number; y: number; keyboard: boolean } | null>(null);

	function answer(decision: Decision) {
		if (sent) return;
		sent = true;
		onanswer(decision, decision === 'deny' && reason.trim() ? reason : undefined);
		// The card goes away on `permission_resolved`; re-enable if that never comes (e.g. the call failed).
		setTimeout(() => (sent = false), 3000);
	}

	const rule = $derived(request.rules?.length ? t('chatInput.perm.rules', { rules: request.rules.join(', ') }) : t('chatInput.perm.wholeTool', { tool: request.tool }));
	const allowLabel = $derived(allowlistLabel(request.rules, request.tool));
	const scopes = $derived<MenuNode[]>([
		menuItem('allow_workspace', t('chatInput.perm.workspace')),
		menuItem('allow_always', t('chatInput.perm.session')),
		menuItem('allow_user', t('chatInput.perm.user'))
	]);

	function openMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		// Above the button (3 rows and padding), so the scope notes below stay readable.
		menu = { x: r.left, y: Math.max(4, r.top - 3 * 26 - 12), keyboard: e.detail === 0 };
	}

	const BTN = 'inline-flex h-[22px] items-center gap-1 rounded-md px-2 disabled:opacity-50';
	const PRIMARY = 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)';
	const SECONDARY = 'bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)';
	const KEY = 'text-[10px] opacity-70';
</script>

<div
	class="overflow-hidden rounded-lg border border-(--vscode-editorWarning-foreground)/50 bg-(--vscode-editorWidget-background) text-(--vscode-foreground)"
	role="group"
	aria-label={t('chatView.permission.title', { tool: request.tool })}
>
	<div class="space-y-1.5 px-2.5 pt-2 pb-1.5">
		<div class="flex items-center gap-1.5 font-medium">
			<Icon name={request.tool === 'Bash' ? 'terminal' : 'shield'} size={13} />
			<span class="min-w-0 truncate">{t('chatView.permission.title', { tool: request.tool })}</span>
		</div>
		{#if request.title}<div class="text-(--vscode-descriptionForeground)">{request.title}</div>{/if}
		{#if request.input_summary}
			<pre class="max-h-32 overflow-auto rounded-md bg-(--vscode-textCodeBlock-background,var(--vscode-input-background)) px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap">{#if request.tool === 'Bash'}<span class="text-(--vscode-descriptionForeground) select-none">$ </span>{/if}{request.input_summary}</pre>
		{/if}
		{#if request.diff}
			<div class="font-mono text-xs">
				<span class="text-(--vscode-gitDecoration-addedResourceForeground,#81b88b)">+{request.diff.added}</span>
				<span class="text-(--vscode-gitDecoration-deletedResourceForeground,#c74e39)">−{request.diff.removed}</span>
				{t('chatView.permission.lines')}
			</div>
		{/if}
		{#if request.detail}<div class="text-xs text-(--vscode-descriptionForeground)">{request.detail}</div>{/if}
		{#if reasonOpen}
			<input
				class="w-full rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 py-0.5 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
				placeholder={t('chatView.permission.reason')}
				aria-label={t('chatView.permission.reason')}
				bind:value={reason}
				onkeydown={(e) => e.key === 'Enter' && !e.isComposing && answer('deny')}
				{@attach (el) => el.focus()}
			/>
		{/if}
	</div>
	<div class="flex flex-wrap items-center gap-1.5 border-t border-(--vscode-widget-border) px-2.5 py-1.5 text-xs">
		<button
			class="min-w-0 truncate text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
			title={t('composer.approve.reasonHint')}
			onclick={() => (reasonOpen = !reasonOpen)}>{reasonOpen ? t('common.cancel') : t('composer.approve.reason')}</button
		>
		<span class="flex-1"></span>
		<button class={[BTN, 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)']} title={t('composer.approve.skipHint')} disabled={sent} onclick={() => answer('deny')}
			>{t('composer.approve.skip')}{#if keys}<span class={KEY}>Esc</span>{/if}</button
		>
		{#if request.can_always}
			<span class="flex min-w-0">
				<button class={[BTN, SECONDARY, 'min-w-0 rounded-r-none']} title={`${t('chatInput.perm.workspace')} · ${rule}`} disabled={sent} onclick={() => answer('allow_workspace')}
					><span class="max-w-40 truncate font-mono">{allowLabel}</span>{#if keys}<span class={KEY}>⇧⏎</span>{/if}</button
				>
				<button
					class={[BTN, SECONDARY, 'rounded-l-none border-l border-(--vscode-button-secondaryForeground)/20 px-1']}
					aria-label={t('chatInput.perm.more')}
					title={t('chatInput.perm.more')}
					aria-haspopup="menu"
					aria-expanded={menu !== null}
					disabled={sent}
					onclick={openMenu}><Icon name="chevronDown" size={11} /></button
				>
			</span>
		{/if}
		<button class={[BTN, PRIMARY]} title={t('chatView.permission.allowHint')} disabled={sent} onclick={() => answer('allow')}>{t('composer.approve.run')}{#if keys}<span class={KEY}>⏎</span>{/if}</button>
	</div>
	{#if menu}
		<div class="border-t border-(--vscode-widget-border) px-2.5 py-1 text-xs text-(--vscode-descriptionForeground)">
			<div>{t('chatInput.perm.workspace')}: {t('chatInput.perm.workspaceHint')}</div>
			<div>{t('chatInput.perm.session')}: {t('chatInput.perm.sessionHint')}</div>
			<div>{t('chatInput.perm.user')}: {t('chatInput.perm.userHint')}</div>
		</div>
		<PopupMenu items={scopes} label={t('chatInput.perm.more')} x={menu.x} y={menu.y} focusFirst={menu.keyboard} onRun={(n) => n.type === 'item' && answer(n.id as Decision)} onClose={() => (menu = null)} />
	{/if}
</div>
