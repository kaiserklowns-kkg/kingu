<script lang="ts">
	// The welcome tour starts with a concrete choice, then gives the small set of shortcuts that
	// make the IDE + Agents split discoverable. Esc or Skip closes it for good.
	import type { IconName } from './Icon.svelte';
	import Icon from './Icon.svelte';
	import KinguMark from './KinguMark.svelte';
	import { commands } from './commands.svelte';
	import { welcome } from './welcomeTour.svelte';
	import { t } from '#lib/i18n/index.ts';

	type Action = { label: string; command: string; primary?: boolean };
	type Step = { icon: IconName | 'kingu'; title: string; body: string; keys: [string, string][]; actions?: Action[] };
	const STEPS = $derived.by((): Step[] => [
		{
			icon: 'kingu',
			title: t('legacyWorkbench.welcome.startTitle'),
			body: t('legacyWorkbench.welcome.startBody'),
			keys: [
				['Editor', '⌘O'],
				['Agents', '⇧⌘A']
			],
			actions: [
				{ label: t('legacyWorkbench.welcome.openFolder'), command: 'workbench.action.files.openFolder', primary: true },
				{ label: t('legacyWorkbench.welcome.newProject'), command: 'kingu.newProject' }
			]
		},
		{
			icon: 'agent',
			title: t('legacyWorkbench.welcome.agentsTitle'),
			body: t('legacyWorkbench.welcome.agentsBody'),
			keys: [
				[t('legacyWorkbench.welcome.switchIdeAgents'), '⇧⌘A'],
				[t('legacyWorkbench.welcome.arkaiPanel'), '⌥⌘B']
			]
		},
		{
			icon: 'search',
			title: t('legacyWorkbench.welcome.keyboardTitle'),
			body: t('legacyWorkbench.welcome.keyboardBody'),
			keys: [
				[t('legacyWorkbench.welcome.allCommands'), '⇧⌘P'],
				[t('legacyWorkbench.welcome.goToFile'), '⌘P'],
				['Zen Mode', '⌘K Z']
			]
		},
		{
			icon: 'settings',
			title: t('legacyWorkbench.welcome.customizeTitle'),
			body: t('legacyWorkbench.welcome.customizeBody'),
			keys: [
				['Settings', '⌘,'],
				['Floating terminal', '⌥⌘A']
			],
			actions: [{ label: t('legacyWorkbench.welcome.checkMachine'), command: 'kingu.setup.open' }]
		}
	]);

	let step = $state(0);
	const s = $derived(STEPS[step]);
	const last = $derived(step === STEPS.length - 1);

	function run(command: string) {
		welcome.close();
		void commands.run(command);
	}
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') welcome.close();
		else if (e.key === 'ArrowRight' && !last) step++;
		else if (e.key === 'ArrowLeft' && step > 0) step--;
		else return;
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && welcome.close()}>
	<div role="dialog" aria-modal="true" aria-labelledby="kg-welcome-title" class="w-full max-w-[520px] overflow-hidden rounded-2xl border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) text-(--vscode-foreground) shadow-2xl shadow-black/50">
		<div class="flex flex-col items-center gap-3 px-8 pt-8 pb-5 text-center">
			<span class="text-(--vscode-foreground)">
				{#if s.icon === 'kingu'}<KinguMark size={52} />{:else}<Icon name={s.icon} size={44} />{/if}
			</span>
			<h2 id="kg-welcome-title" class="text-lg font-semibold">{s.title}</h2>
			<p class="text-[13px] leading-relaxed text-(--vscode-descriptionForeground)">{s.body}</p>
			<div class="mt-1 flex flex-wrap justify-center gap-2">
				{#each s.keys as [label, key] (label)}
					<span class="flex items-center gap-2 rounded-lg border border-(--vscode-widget-border) px-2.5 py-1 text-xs">
						<span class="text-(--vscode-descriptionForeground)">{label}</span>
						<kbd class="font-mono">{key}</kbd>
					</span>
				{/each}
			</div>
			{#if s.actions}
				<div class="mt-2 flex flex-wrap justify-center gap-2">
					{#each s.actions as action (action.command)}
						<button
							class={action.primary
								? 'rounded-md bg-(--vscode-button-background) px-3 py-1.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90'
								: 'rounded-md border border-(--vscode-widget-border) px-3 py-1.5 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)'}
							onclick={() => run(action.command)}
						>{action.label}</button>
					{/each}
				</div>
			{/if}
		</div>
		<div class="flex items-center gap-2 border-t border-(--vscode-widget-border) px-5 py-3">
			<div class="flex flex-1 gap-1.5" aria-label={t('legacyWorkbench.welcome.stepOf', { step: step + 1, count: STEPS.length })}>
				{#each STEPS as _, i (i)}
					<button class={['h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-(--vscode-button-background)' : 'w-1.5 bg-(--vscode-widget-border)']} aria-label={t('legacyWorkbench.welcome.step', { step: i + 1 })} onclick={() => (step = i)}></button>
				{/each}
			</div>
			<button class="rounded-md px-3 py-1.5 text-[13px] text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => welcome.close()}>{t('legacyWorkbench.welcome.skip')}</button>
			{#if step > 0}
				<button class="rounded-md px-3 py-1.5 text-[13px] hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => step--}>{t('legacyWorkbench.welcome.back')}</button>
			{/if}
			{#if last}
				<button class="rounded-md bg-(--vscode-button-background) px-3 py-1.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90" onclick={() => welcome.close()}>{t('legacyWorkbench.welcome.getStarted')}</button>
			{:else}
				<!-- svelte-ignore a11y_autofocus -->
				<button autofocus class="rounded-md bg-(--vscode-button-background) px-3 py-1.5 text-[13px] text-(--vscode-button-foreground) hover:opacity-90" onclick={() => step++}>{t('legacyWorkbench.welcome.next')}</button>
			{/if}
		</div>
	</div>
</div>
