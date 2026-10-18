<script lang="ts">
	// Quick reply for a terminal agent's question: while the task's CLI asks one (its hooks carried
	// the options), the question card types the chosen answer into that task's own CLI terminal.
	import QuestionCard from '#lib/agent/QuestionCard.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { cliSessions } from './cliSessions.svelte';
	import { cliName } from './agentCli';

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
				submitLabel="พิมพ์คำตอบลง terminal"
				dismissLabel="ซ่อน"
				note="ตอบใน terminal ของ {run ? cliName(run) : 'agent'} ให้ (หรือตอบเองใน terminal ก็ได้)"
				onsubmit={async (sels) => {
					if (!(await cliSessions.answer(slug, sels))) status.flash('ส่งคำตอบไม่ได้: คำถามนี้ปิดไปแล้ว หรือ terminal ของ agent เปลี่ยนไป', 6000);
				}}
				ondismiss={() => (hidden = id)}
			/>
		</div>
	{/key}
{/if}
