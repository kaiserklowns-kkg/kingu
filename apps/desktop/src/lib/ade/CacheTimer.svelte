<script lang="ts">
	// Orca's CacheTimer: the countdown to an idle Claude task's prompt-cache expiry
	// (kingu.agent.promptCacheTimer / kingu.agent.promptCacheTtl). Renders nothing when off or not applicable.
	import { settings } from '#lib/settings/settings.svelte.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import type { TaskView } from './model';
	import { formatCacheLeft, promptCacheLeft, promptCacheTtl } from './promptCache';
	import { t as tr } from '#lib/i18n/index.ts';

	let { view }: { view: TaskView } = $props();
	const enabled = $derived(settings.get<boolean>('kingu.agent.promptCacheTimer') === true);
	const ttl = $derived(promptCacheTtl(settings.get<string>('kingu.agent.promptCacheTtl')));
	let now = $state(Date.now());
	const left = $derived(enabled ? promptCacheLeft(view, ttl, now) : null);

	$effect(() => {
		if (!enabled) return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
</script>

{#if left !== null}
	<span
		class={['inline-flex shrink-0 items-center gap-0.5 font-mono text-[11px] tabular-nums', left === 0 ? 'text-(--vscode-descriptionForeground) line-through' : left < 60_000 ? 'text-(--vscode-editorWarning-foreground)' : 'text-(--vscode-descriptionForeground)']}
		title={left === 0 ? tr('legacyAde.cacheTimer.expired') : tr('legacyAde.cacheTimer.timeLeft')}
	>
		<Icon name="clock" size={11} />{formatCacheLeft(left)}
	</span>
{/if}
