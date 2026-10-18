<script lang="ts">
	// Toasts at the bottom right, above the status bar (VS Code's notification toasts, Orca's sonner).
	import Icon from './Icon.svelte';
	import { notifications } from './notifications.svelte';

	const TONE = { error: 'text-(--vscode-errorForeground)', warning: 'text-(--vscode-editorWarning-foreground)', info: 'text-(--vscode-editorInfo-foreground)' };
</script>

<div class="pointer-events-none fixed right-3 bottom-[calc(var(--kg-statusbar-height)+10px)] z-50 flex w-[360px] max-w-[calc(100vw-24px)] flex-col gap-2" aria-live="polite">
	{#each notifications.toasts as t (t.id)}
		<div
			role={t.severity === 'error' ? 'alert' : 'status'}
			class="kg-toast pointer-events-auto flex items-start gap-2.5 rounded-lg border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) px-3 py-2.5 text-[13px] text-(--vscode-foreground) shadow-xl shadow-black/40"
		>
			<span class={['mt-0.5 shrink-0', TONE[t.severity]]}><Icon name={t.severity} size={16} /></span>
			<p class="kg-selectable min-w-0 flex-1 leading-snug break-words">{t.message}{#if t.count > 1}<span class="ml-1.5 rounded-full bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)">{t.count}</span>{/if}</p>
			<button class="grid size-5 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)" aria-label="ปิดการแจ้งเตือน" onclick={() => notifications.dismiss(t.id)}>
				<Icon name="close" size={13} />
			</button>
		</div>
	{/each}
</div>

<style>
	.kg-toast {
		animation: kg-toast-in 180ms ease-out;
	}
	@keyframes kg-toast-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.kg-toast {
			animation: none;
		}
	}
</style>
