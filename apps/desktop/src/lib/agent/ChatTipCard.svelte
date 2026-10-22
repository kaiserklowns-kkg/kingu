<script lang="ts">
	// The getting-started tip (VS Code's chatTipContentPart, chatInputNotice.css): "Tip:" and the
	// tip's text in a notice docked on the chat input (no bottom border; the input squares its top
	// corners). Hovering or focusing it shows a toolbar on its top edge: Previous tip, Next tip
	// (disabled while there is one tip), Dismiss tip (✓: never again, and no tips for the rest of
	// the session) and Disable tips (chat.tips.enabled); right-click offers Dismiss this tip and
	// Disable tips. Links run the tip's own actions.
	import Codicon from '#lib/workbench/Codicon.svelte';
	import PopupMenu, { menuItem } from '#lib/workbench/PopupMenu.svelte';
	import { t, type MessageKey } from '#lib/i18n/index.ts';
	import { tipParts, type TipAction, type TipDef } from './chatTips.ts';

	let {
		tip,
		keys,
		several,
		onaction,
		onstep,
		ondismiss,
		ondismissthis,
		ondisable
	}: {
		tip: TipDef;
		/** Shortcut labels for the messages' `{key}`. */
		keys: Record<NonNullable<TipDef['keyLabel']>, string>;
		/** More than one tip may show: Previous / Next are enabled. */
		several: boolean;
		onaction: (action: TipAction) => void;
		onstep: (dir: 1 | -1) => void;
		/** The toolbar's ✓: this tip never again, and no more tips this session. */
		ondismiss: () => void;
		/** The context menu's Dismiss this tip. */
		ondismissthis: () => void;
		ondisable: () => void;
	} = $props();

	const message = $derived(tip.keyLabel ? t(tip.key as Extract<MessageKey, 'chatTips.modelPicker'>, { key: keys[tip.keyLabel] }) : t(tip.key as Extract<MessageKey, 'chatTips.planMode'>));
	const parts = $derived(tipParts(message));
	const plain = $derived(parts.map((p) => p.text).join(''));
	let menuAt = $state<{ x: number; y: number } | null>(null);
</script>

<div class="chat-getting-started-tip-container">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="chat-input-notice chat-input-notice-tip chat-tip-widget"
		role="note"
		tabindex="0"
		aria-roledescription={t('chatTips.label')}
		aria-label={`${t('chatTips.prefix')} ${plain}`}
		oncontextmenu={(e) => {
			e.preventDefault();
			menuAt = { x: e.clientX, y: e.clientY };
		}}
	>
		<div class="rendered-markdown">
			<p>
				<strong>{t('chatTips.prefix')}</strong>
				{#each parts as p, i (i)}
					{#if p.kind === 'text'}{p.text}{:else if p.kind === 'code'}<code>{p.text}</code>{:else}<a href={'#'} role="button" onclick={(e) => (e.preventDefault(), tip.actions?.[p.action] && onaction(tip.actions[p.action]))}>{p.text}</a>{/if}
				{/each}
			</p>
		</div>
		<div class="chat-tip-toolbar">
			<div class="monaco-toolbar" role="toolbar" aria-label={t('chatTips.label')}>
				<button type="button" class="action-label" aria-label={t('chatTips.previous')} title={t('chatTips.previous')} disabled={!several} onclick={() => onstep(-1)}><Codicon id="chevron-left" /></button>
				<button type="button" class="action-label" aria-label={t('chatTips.next')} title={t('chatTips.next')} disabled={!several} onclick={() => onstep(1)}><Codicon id="chevron-right" /></button>
				<button type="button" class="action-label" aria-label={t('chatTips.dismiss')} title={t('chatTips.dismiss')} onclick={ondismiss}><Codicon id="check" /></button>
				<button type="button" class="action-label" aria-label={t('chatTips.disable')} title={t('chatTips.disable')} onclick={ondisable}><Codicon id="bell-slash" /></button>
			</div>
		</div>
	</div>
</div>
{#if menuAt}
	<PopupMenu
		items={[menuItem('dismiss', t('chatTips.dismissThis')), menuItem('disable', t('chatTips.disable'))]}
		label={t('chatTips.label')}
		x={menuAt.x}
		y={menuAt.y}
		onRun={(n) => n.type === 'item' && (n.id === 'dismiss' ? ondismissthis() : ondisable())}
		onClose={() => (menuAt = null)}
	/>
{/if}
