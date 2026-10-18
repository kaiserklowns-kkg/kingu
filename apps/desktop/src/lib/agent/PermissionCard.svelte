<script lang="ts">
	// A pending permission request with allow / always allow / deny (+ optional reason), like VS
	// Code's tool confirmation. Shared by the Agent panel and the ADE task page (through ChatList).
	import { t } from '#lib/i18n/index.ts';
	import type { Decision, PermissionRequest } from './events';

	let { request, onanswer }: { request: PermissionRequest; onanswer: (decision: Decision, message?: string) => void } = $props();

	let reason = $state('');
	let sent = $state(false);

	function answer(decision: Decision) {
		if (sent) return;
		sent = true;
		onanswer(decision, decision === 'deny' ? reason : undefined);
		// The card goes away on `permission_resolved`; re-enable if that never comes (e.g. the call failed).
		setTimeout(() => (sent = false), 3000);
	}

	const BTN = 'rounded-sm px-2 py-0.5 disabled:opacity-50';
</script>

<div
	class="space-y-1.5 rounded border border-(--vscode-editorWarning-foreground)/60 bg-(--vscode-editorWidget-background) p-2 text-(--vscode-foreground)"
	role="group"
	aria-label={t('chatView.permission.title', { tool: request.tool })}
>
	<div class="font-medium">{t('chatView.permission.title', { tool: request.tool })}</div>
	{#if request.title}<div class="text-(--vscode-descriptionForeground)">{request.title}</div>{/if}
	{#if request.input_summary}
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
	<div class="flex flex-wrap gap-1.5">
		<button class={[BTN, 'bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)']} title={t('chatView.permission.allowHint')} disabled={sent} onclick={() => answer('allow')}
			>{t('chatView.permission.allow')}</button
		>
		{#if request.can_always}
			<button
				class={[BTN, 'bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)']}
				title={t('chatView.permission.alwaysHint')}
				disabled={sent}
				onclick={() => answer('allow_always')}>{t('chatView.permission.always')}</button
			>
		{/if}
		<button
			class={[BTN, 'bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)']}
			disabled={sent}
			onclick={() => answer('deny')}>{t('chatView.permission.deny')}</button
		>
	</div>
</div>
