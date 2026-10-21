<script lang="ts">
	// An empty chat's welcome (VS Code's chat welcome view): the chat-sparkle icon, the title for
	// the mode ("Build with Agent", "Ask about your code"), the disclaimer, and, while the folder has
	// no agent instructions, "Generate Agent Instructions to onboard AI onto your codebase."
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { tipParts } from './chatTips.ts';

	let { title, instructions, ongenerate }: { title: string; /** Offer Generate Agent Instructions. */ instructions: boolean; ongenerate: () => void } = $props();

	const parts = $derived(tipParts(t('chatWelcome.instructions')));
</script>

<div class="flex h-full flex-col items-center justify-center overflow-y-auto px-5 py-6 text-center">
	<span class="relative mb-6 grid size-10 place-items-center text-(--vscode-descriptionForeground)" aria-hidden="true">
		<Codicon id="comment-discussion" size={40} />
		<span class="absolute -top-1 -right-1.5 bg-(--vscode-sideBar-background) text-(--vscode-descriptionForeground)"><Codicon id="sparkle" size={16} /></span>
	</span>
	<h2 class="mt-[5px] px-2 text-[13px] leading-normal font-semibold text-(--vscode-foreground)">{title}</h2>
	<div class="mx-auto mt-2 max-w-[280px] px-5 text-[12px] leading-[18px] text-(--vscode-descriptionForeground)">
		<p>{t('chatWelcome.disclaimer')}</p>
		{#if instructions}
			<p>
				{#each parts as p, i (i)}
					{#if p.kind === 'link'}<button
							type="button"
							class="cursor-pointer text-(--vscode-textLink-foreground) hover:underline focus-visible:underline focus-visible:outline focus-visible:outline-(--vscode-focusBorder)"
							onclick={ongenerate}>{p.text}</button
						>{:else}{p.text}{/if}
				{/each}
			</p>
		{/if}
	</div>
</div>
