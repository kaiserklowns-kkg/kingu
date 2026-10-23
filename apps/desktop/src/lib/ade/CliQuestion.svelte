<script lang="ts">
	// Quick reply for a terminal agent's question: while the task's CLI asks one (its hooks carried
	// the options), the question card types the chosen answer into that task's own CLI terminal.
	import QuestionCard from '#lib/agent/QuestionCard.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { cliSessions } from './cliSessions.svelte';
	import { cliName } from './agentCli';
	import { t } from '#lib/i18n/index.ts';

	let { slug, class: klass = '' }: { slug: string; class?: string } = $props();

	const hook = $derived(cliSessions.hooks[slug]);
	const ask = $derived(hook?.phase === 'waiting' && hook.question ? hook.ask : undefined);
	/** Which question this is: a different one gets a fresh card (and shows again after "hide"). */
	const id = $derived(ask ? JSON.stringify(ask) : '');
	let hidden = $state('');
	const run = $derived(cliSessions.sessions[slug]?.run);
</script>

{#if ask && id !== hidden}
	{#key id}
		<div class={klass}>
			<QuestionCard
				prompt={ask}
				submitLabel={t('legacyAde.cliQuestion.submit')}
				dismissLabel={t('legacyAde.cliQuestion.dismiss')}
				note={t('legacyAde.cliQuestion.note', { agent: run ? cliName(run) : 'agent' })}
				onsubmit={async (sels) => {
					if (!(await cliSessions.answer(slug, sels))) status.flash(t('legacyAde.cliQuestion.sendFailed'), 6000);
				}}
				ondismiss={() => (hidden = id)}
			/>
		</div>
	{/key}
{/if}
