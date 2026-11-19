<script lang="ts">
	// Add Quick Command (Orca's TerminalQuickCommandDialog: Label, Command, Scope Global / Project):
	// saves into `kingu.terminal.quickCommands` of the user settings (Global) or of Kingu's own
	// per-project store (Project), never the repository's file. Agent prompts are not offered yet.
	import { onMount } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { withQuickCommand } from '#lib/terminal/adeTerminalOptions.ts';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui';

	let { onclose, onsaved }: { onclose: () => void; onsaved?: (label: string) => void } = $props();

	const ID = 'kingu.terminal.quickCommands';
	let label = $state('');
	let command = $state('');
	let scope = $state<'user' | 'repo'>('user');
	let problem = $state('');
	let saving = $state(false);
	let first: HTMLInputElement | undefined = $state();
	onMount(() => first?.focus());

	async function save(e: Event) {
		e.preventDefault();
		if (saving) return;
		const layer = scope === 'repo' ? settings.repo.values : settings.user.values;
		const next = withQuickCommand(layer[ID], label, command);
		if (typeof next === 'string') return void (problem = t(`legacyAde.quickCommand.problem.${next}`));
		saving = true;
		problem = '';
		try {
			await settings.set(ID, next, scope);
			onsaved?.(label.trim());
			onclose();
		} catch (err) {
			problem = String(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="fixed inset-0 z-50 grid place-items-center bg-black/30" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onclose()}>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape from any field) -->
	<form class="w-[460px] max-w-[calc(100vw-32px)] space-y-3 rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-4 text-[13px] shadow-xl" aria-label={t('legacyAde.quickCommand.title')} onsubmit={save} onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onclose())}>
		<div>
			<h2 class="font-semibold">{t('legacyAde.quickCommand.title')}</h2>
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.hint')}</p>
		</div>
		<label class="block space-y-1">
			<span class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.label')}</span>
			<input bind:this={first} class={INPUT} placeholder={t('legacyAde.quickCommand.labelPlaceholder')} bind:value={label} disabled={saving} />
		</label>
		<label class="block space-y-1">
			<span class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.command')}</span>
			<textarea class={[INPUT, 'h-20 resize-y font-mono']} placeholder="bun run dev" bind:value={command} disabled={saving} spellcheck="false"></textarea>
		</label>
		<fieldset class="space-y-1">
			<legend class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.scope')}</legend>
			<div class="flex gap-4">
				<label class="flex items-center gap-1.5"><input type="radio" name="scope" value="user" bind:group={scope} disabled={saving} />{t('legacyAde.quickCommand.global')}</label>
				<label class="flex items-center gap-1.5" title={workspace.root ? undefined : t('legacyAde.quickCommand.noProject')}><input type="radio" name="scope" value="repo" bind:group={scope} disabled={saving || !workspace.root} />{t('legacyAde.quickCommand.project')}</label>
			</div>
		</fieldset>
		{#if problem}<p class="text-xs text-(--vscode-errorForeground)" role="alert">{problem}</p>{/if}
		<div class="flex justify-end gap-1.5">
			<button type="button" class={BUTTON_SECONDARY} onclick={onclose}>{t('common.cancel')}</button>
			<button type="submit" class={BUTTON} disabled={saving || !label.trim() || !command.trim()}>{t('common.save')}</button>
		</div>
	</form>
</div>
