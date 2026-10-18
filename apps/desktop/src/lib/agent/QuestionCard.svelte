<script lang="ts">
	// Questions the agent asks (AskUserQuestion, …): each with its options (one pick, or any for a
	// multi-select) and a line for the user's own words. Answers the timeline's pending request, or
	// types the answer into a CLI agent's terminal (`note` says so). Choosing is ask.ts's.
	import { t } from '#lib/i18n/index.ts';
	import { isComplete, type AskPrompt, type AskSelection } from './ask';

	let {
		prompt,
		onsubmit,
		ondismiss,
		submitLabel,
		dismissLabel,
		note
	}: {
		prompt: AskPrompt;
		onsubmit: (selections: AskSelection[]) => unknown;
		ondismiss?: () => unknown;
		submitLabel?: string;
		dismissLabel?: string;
		note?: string;
	} = $props();

	// One card per question request: its prompt never changes underneath it.
	const blank = () => prompt.questions.map((): AskSelection => ({ indices: [], other: '' }));
	let sels = $state<AskSelection[]>(blank());
	let sent = $state(false);
	const ready = $derived(isComplete(prompt, sels));

	function pick(qi: number, i: number) {
		const s = sels[qi];
		if (prompt.questions[qi].multiSelect) s.indices = s.indices.includes(i) ? s.indices.filter((x) => x !== i) : [...s.indices, i];
		else {
			s.indices = [i];
			s.other = '';
		}
	}

	function typed(qi: number) {
		// A single-select takes one answer: own words replace the picked option.
		if (!prompt.questions[qi].multiSelect && sels[qi].other?.trim()) sels[qi].indices = [];
	}

	async function act(fn: () => unknown) {
		if (sent) return;
		sent = true;
		try {
			await fn();
		} finally {
			// The card goes away once answered; re-enable if that never happens (e.g. the call failed).
			setTimeout(() => (sent = false), 3000);
		}
	}
</script>

<div class="space-y-2 rounded border border-(--vscode-charts-purple,#B180D7)/70 bg-(--vscode-editorWidget-background) p-2 text-(--vscode-foreground)" role="group" aria-label={t('chatView.question.title')}>
	<div class="font-medium text-(--vscode-charts-purple,#B180D7)">{t('chatView.question.title')}</div>
	{#each prompt.questions as q, qi (qi)}
		{@const s = sels[qi]}
		<fieldset class="space-y-1">
			<legend class="mb-1">
				{#if q.header}<span class="mr-1 rounded-sm bg-(--vscode-badge-background) px-1 text-[10px] text-(--vscode-badge-foreground)">{q.header}</span>{/if}
				<span class="whitespace-pre-wrap">{q.question}</span>
				{#if q.multiSelect}<span class="text-(--vscode-descriptionForeground)"> {t('chatView.question.multi')}</span>{/if}
			</legend>
			{#each q.options as o, i (i)}
				{@const on = s.indices.includes(i)}
				<button
					type="button"
					role={q.multiSelect ? 'checkbox' : 'radio'}
					aria-checked={on}
					class={['flex w-full items-start gap-1.5 rounded border px-2 py-1 text-left hover:bg-(--vscode-list-hoverBackground)', on ? 'border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground)/40' : 'border-(--vscode-widget-border)']}
					disabled={sent}
					onclick={() => pick(qi, i)}
				>
					<span class="w-4 shrink-0 font-mono text-(--vscode-descriptionForeground)">{q.multiSelect ? (on ? '☑' : '☐') : on ? '◉' : '○'}</span>
					<span class="min-w-0">
						<span class="block">{o.label}</span>
						{#if o.description}<span class="block text-(--vscode-descriptionForeground)">{o.description}</span>{/if}
					</span>
				</button>
			{/each}
			<input
				class="w-full rounded border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 py-0.5 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
				placeholder={t('chatView.question.other')}
				aria-label={t('chatView.question.otherFor', { question: q.question })}
				disabled={sent}
				bind:value={s.other}
				oninput={() => typed(qi)}
			/>
		</fieldset>
	{/each}
	{#if note}<div class="text-(--vscode-descriptionForeground)">{note}</div>{/if}
	<div class="flex flex-wrap gap-1.5">
		<button
			type="button"
			class="rounded bg-(--vscode-button-background) px-2 py-0.5 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-50"
			disabled={sent || !ready}
			title={ready ? undefined : t('chatView.question.answerAll')}
			onclick={() => act(() => onsubmit($state.snapshot(sels)))}>{submitLabel ?? t('chatView.question.submit')}</button
		>
		{#if ondismiss}
			<button
				type="button"
				class="rounded bg-(--vscode-button-secondaryBackground) px-2 py-0.5 text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground) disabled:opacity-50"
				disabled={sent}
				onclick={() => act(() => ondismiss?.())}>{dismissLabel ?? t('chatView.question.dismiss')}</button
			>
		{/if}
	</div>
</div>
