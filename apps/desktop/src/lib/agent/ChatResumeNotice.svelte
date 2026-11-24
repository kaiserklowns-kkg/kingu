<script lang="ts">
	// Above the composer: a chat Kingu's exit cut off mid-turn (Orca 1.4.272's
	// NativeChatInterruptedContinue: Continue / Dismiss), and a chat whose turn stopped on the
	// agent's usage limit (Orca 1.4.271's NativeChatUsageLimitRow: which limit, when it resets,
	// Continue, and the automatic continue at the reset with Cancel). Hidden while a turn runs.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { chats } from './chats.svelte.ts';
	import { agentRuntimes } from './runtimes.svelte.ts';
	import { CLAUDE, runtimeOf } from './runtimes.ts';
	import { turnBusy } from './chatInput.ts';
	import { autoContinueAt, formatResetClock, limitPhase } from './chatLimits.ts';

	let { chatId }: { chatId: string } = $props();

	const meta = $derived(chats.get(chatId));
	const busy = $derived(turnBusy(chats.run(chatId)));
	const agent = $derived(agentRuntimes.list.find((r) => r.id === runtimeOf(meta))?.name ?? (runtimeOf(meta) === CLAUDE.id ? CLAUDE.name : runtimeOf(meta)));

	// The clock the row reads: a minute tick, and at once on return to the window (Orca's
	// use-usage-limit-continue-clock re-checks on focus and visibility).
	let now = $state(Date.now());
	$effect(() => {
		const tick = () => (now = Date.now());
		const timer = setInterval(tick, 30_000);
		window.addEventListener('focus', tick);
		return () => (clearInterval(timer), window.removeEventListener('focus', tick));
	});

	const cut = $derived(meta?.usage_limit ?? null);
	const phase = $derived(cut ? limitPhase(cut, now) : null);
	const autoOn = $derived(settings.get<boolean>('kingu.chat.autoContinueAfterUsageLimit') !== false);
	/** When Kingu continues it by itself; null when it won't (no reset, cancelled, too old, setting off). */
	const autoAt = $derived(cut && autoOn ? autoContinueAt(cut, now) : null);
	const schedulable = $derived(!!cut && autoContinueAt({ ...cut, auto_off: false }, now) !== null);
	const resetTime = $derived(typeof cut?.resets_at === 'number' ? formatResetClock(cut.resets_at, now) : null);
	const limitTitle = $derived(
		cut?.window === 'weekly' || cut?.window === 'weeklyModel' ? t('chatLimits.titleWeekly', { agent }) : cut?.window === 'credits' ? t('chatLimits.titleCredits', { agent }) : t('chatLimits.titleUsage', { agent })
	);
	const limitLine = $derived(phase === 'unknown' ? t('chatLimits.resetUnknown') : phase === 'ready' ? t('chatLimits.canContinueNow', { agent }) : t('chatLimits.canContinueAt', { time: resetTime ?? '' }));

	let sending = $state(false);
	async function run(fn: () => Promise<unknown>) {
		sending = true;
		try {
			await fn();
		} finally {
			sending = false;
		}
	}

	const BTN = 'inline-flex h-6 items-center gap-1 rounded-md px-2 disabled:opacity-50';
	const PRIMARY = `${BTN} bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)`;
	const SECONDARY = `${BTN} border border-(--vscode-widget-border) hover:bg-(--vscode-toolbar-hoverBackground)`;
	const LINK = 'text-(--vscode-textLink-foreground) hover:underline disabled:opacity-50';
</script>

{#if meta && !busy && meta.interrupted}
	<div class="flex items-start gap-2.5 rounded-[8px] border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) px-3 py-2 text-xs" data-chat-notice="interrupted" data-crash={meta.interrupted.crash}>
		<Codicon id={meta.interrupted.crash ? 'warning' : 'debug-pause'} size={14} class="mt-0.5 shrink-0 text-(--vscode-editorWarning-foreground)" />
		<div class="min-w-0 flex-1">
			<p class="font-semibold">{meta.interrupted.crash ? t('chatResume.crashTitle') : t('chatResume.quitTitle')}</p>
			<p class="text-(--vscode-descriptionForeground)">{t('chatResume.hint')}{#if chats.hasPartial(chatId)}{' '}{t('chatResume.partialKept')}{/if}</p>
			<div class="mt-1.5 flex flex-wrap gap-1.5">
				<button type="button" class={PRIMARY} disabled={sending} onclick={() => run(() => chats.resumeInterrupted([chatId]))}><Codicon id="debug-continue" size={12} />{t('chatResume.continue')}</button>
				<button type="button" class={SECONDARY} onclick={() => chats.dismissInterrupted(chatId)}>{t('chatResume.dismiss')}</button>
			</div>
		</div>
	</div>
{/if}

{#if meta && !busy && cut}
	<div class="flex items-start gap-2.5 rounded-[8px] border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) px-3 py-2 text-xs" data-chat-notice="usage-limit" data-phase={phase}>
		<Codicon id="watch" size={14} class="mt-0.5 shrink-0 text-(--vscode-editorWarning-foreground)" />
		<div class="min-w-0 flex-1">
			<p class="font-semibold">{limitTitle}</p>
			<p class="text-(--vscode-descriptionForeground)" role="status">{limitLine}</p>
			{#if autoAt !== null}
				<p class="text-(--vscode-descriptionForeground)">
					{t('chatLimits.autoAt', { time: formatResetClock(autoAt, now) })}
					<button type="button" class={LINK} onclick={() => chats.cancelAutoContinue(chatId)}>{t('chatLimits.autoCancel')}</button>
				</p>
			{:else if schedulable && autoOn && cut.auto_off}
				<p class="text-(--vscode-descriptionForeground)">
					{t('chatLimits.autoOff')}
					<button type="button" class={LINK} onclick={() => chats.resumeAutoContinue(chatId)}>{t('chatLimits.autoUndo')}</button>
				</p>
			{:else if schedulable && !autoOn && phase === 'waiting'}
				<p><button type="button" class={LINK} onclick={() => void settings.set('kingu.chat.autoContinueAfterUsageLimit', true, 'user')}>{t('chatLimits.turnOn')}</button></p>
			{/if}
			<div class="mt-1.5 flex flex-wrap gap-1.5">
				<button
					type="button"
					class={phase === 'waiting' ? SECONDARY : PRIMARY}
					disabled={sending}
					title={phase === 'waiting' ? t('chatLimits.continueEarly') : undefined}
					onclick={() => run(() => chats.continueAfterLimit(chatId))}><Codicon id="debug-continue" size={12} />{t('chatLimits.continue')}</button
				>
				<button type="button" class={SECONDARY} onclick={() => chats.dismissLimit(chatId)}>{t('chatLimits.dismiss')}</button>
			</div>
		</div>
	</div>
{/if}
