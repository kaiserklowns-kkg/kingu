<script lang="ts">
	// Quick reply for a terminal agent's question: while the task's CLI asks one (its hooks carried
	// the options), the question card types the chosen answer into that task's own CLI terminal.
	// A permission prompt (its hooks said so) gets Allow / Deny, which press Enter (the highlighted
	// first choice, "Yes" / "Allow once") or Esc in that terminal, like the phone does.
	import QuestionCard from '#lib/agent/QuestionCard.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { cliSessions } from './cliSessions.svelte';
	import { cliName } from './agentCli';
	import { t } from '#lib/i18n/index.ts';
	import { BUTTON, BUTTON_SECONDARY } from './ui';

	let { slug, class: klass = '' }: { slug: string; class?: string } = $props();

	const hook = $derived(cliSessions.hooks[slug]);
	const ask = $derived(hook?.phase === 'waiting' && hook.question ? hook.ask : undefined);
	/** Which question this is: a different one gets a fresh card (and shows again after "hide"). */
	const id = $derived(ask ? JSON.stringify(ask) : '');
	let hidden = $state('');
	const run = $derived(cliSessions.sessions[slug]?.run);
	const asking = $derived(hook?.phase === 'waiting' && hook.permission ? `${hook.at}:${hook.message ?? ''}` : '');
	let answering = $state(false);
	async function permit(allow: boolean) {
		if (answering) return;
		answering = true;
		try {
			if (!(await cliSessions.answerPermission(slug, allow))) status.flash(t('legacyAde.cliQuestion.sendFailed'), 6000);
		} finally {
			answering = false;
		}
	}
</script>

{#if asking && asking !== hidden}
	<div class={klass}>
		<div class="space-y-2 rounded-md border border-(--vscode-editorWarning-foreground) bg-(--vscode-editorWidget-background) p-3" role="alertdialog" aria-label={t('legacyAde.cliQuestion.permissionTitle')}>
			<div class="text-xs font-medium">{t('legacyAde.cliQuestion.permissionTitle')}</div>
			<div class="text-xs break-words text-(--vscode-descriptionForeground)">{hook?.message}</div>
			<div class="flex flex-wrap items-center gap-1.5">
				<button class={BUTTON} disabled={answering} onclick={() => permit(true)}>{t('legacyAde.cliQuestion.allow')}</button>
				<button class={BUTTON_SECONDARY} disabled={answering} onclick={() => permit(false)}>{t('legacyAde.cliQuestion.deny')}</button>
				<button class="ml-auto text-[11px] text-(--vscode-textLink-foreground) hover:underline" onclick={() => (hidden = asking)}>{t('legacyAde.cliQuestion.dismiss')}</button>
			</div>
			<div class="text-[11px] text-(--vscode-descriptionForeground)">{t('legacyAde.cliQuestion.permissionNote', { agent: run ? cliName(run) : 'agent' })}</div>
		</div>
	</div>
{/if}

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
