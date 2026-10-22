<script lang="ts">
	// An empty chat's welcome (VS Code's chat welcome view, chatViewWelcome.css): the Arkai logo,
	// the title for the mode ("Build with Agent", "Ask about your code"), the disclaimer, and,
	// while the folder has no agent instructions, "Generate Agent Instructions to onboard AI onto
	// your codebase."
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { tipParts } from './chatTips.ts';

	let { title, instructions, ongenerate }: { title: string; /** Offer Generate Agent Instructions. */ instructions: boolean; ongenerate: () => void } = $props();

	const parts = $derived(tipParts(t('chatWelcome.instructions')));
</script>

<div class="chat-welcome-view-container">
	<div class="chat-welcome-view">
		<div class="chat-welcome-view-icon" aria-hidden="true"><Icon name="agent" size={40} /></div>
		<div class="chat-welcome-view-title">{title}</div>
		<div class="chat-welcome-view-message"><div class="rendered-markdown"><p>{t('chatWelcome.disclaimer')}</p></div></div>
		{#if instructions}
			<div class="chat-welcome-view-disclaimer">
				<div class="rendered-markdown">
					<p>
						{#each parts as p, i (i)}
							{#if p.kind === 'link'}<a href={'#'} role="button" onclick={(e) => (e.preventDefault(), ongenerate())}>{p.text}</a>{:else}{p.text}{/if}
						{/each}
					</p>
				</div>
			</div>
		{/if}
	</div>
</div>
