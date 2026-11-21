<script lang="ts">
	// Add Quick Command (Orca's TerminalQuickCommandDialog: Action Command / Prompt, Label, the text,
	// Scope Global / Project): a command goes to `kingu.terminal.quickCommands`, a prompt for the
	// agent to `kingu.terminal.quickPrompts`, in the user settings (Global) or Kingu's own
	// per-project store (Project), never the repository's file.
	import { onMount, untrack } from 'svelte';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { QUICK_INSERT_ID, withoutQuickCommand, withQuickCommand } from '#lib/terminal/adeTerminalOptions.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { enabledBins } from './agentCli';
	import { CUSTOM_PICK, KNOWN_BINS, pickerItems } from './agentProfiles';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui';

	type Scope = 'user' | 'repo';
	type Kind = 'command' | 'prompt';
	let { onclose, onsaved, initial }: { onclose: () => void; onsaved?: (label: string) => void; /** Edit Quick Command: the one being changed and where it is kept. */ initial?: { kind: Kind; label: string; command: string; scope: Scope; agent?: string; appendEnter?: boolean } } = $props();

	const IDS: Record<Kind, string> = { command: 'kingu.terminal.quickCommands', prompt: 'kingu.terminal.quickPrompts' };
	let kind = $state<Kind>(untrack(() => initial?.kind ?? 'command'));
	// A prompt's agent (Orca's Choose agent): '' = kingu.agent.cli. Kept in kingu.terminal.quickPromptAgents.
	const AGENTS_ID = 'kingu.terminal.quickPromptAgents';
	let agent = $state(untrack(() => initial?.agent ?? ''));
	// Orca's Append Enter (on by default): off types the command without running it (kingu.terminal.quickCommandsInsert).
	let appendEnter = $state(untrack(() => initial?.appendEnter ?? true));
	let found = $state<string[]>([]);
	onMount(() => {
		void invoke<string[]>('agent_cli_found', { names: KNOWN_BINS })
			.then((f) => (found = f))
			.catch(() => (found = []));
	});
	const agentRows = $derived(pickerItems(enabledBins(found, settings.get<string[]>('kingu.agent.disabled'), null), '').filter((r) => r.id !== CUSTOM_PICK));
	const defaultAgent = $derived(settings.get<string>('kingu.agent.cli') || 'claude');
	let label = $state(untrack(() => initial?.label ?? ''));
	let command = $state(untrack(() => initial?.command ?? ''));
	let scope = $state<Scope>(untrack(() => initial?.scope ?? 'user'));
	let problem = $state('');
	let saving = $state(false);
	let first: HTMLInputElement | undefined = $state();
	onMount(() => first?.focus());

	/** The prompt's agent next to it (same scope, same label); an old label or scope loses its entry. */
	async function saveAgent() {
		const agentsOf = (s: Scope) => (s === 'repo' ? settings.repo.values : settings.user.values)[AGENTS_ID];
		if (initial?.kind === 'prompt' && (initial.label !== label.trim() || initial.scope !== scope || kind !== 'prompt')) {
			const old = agentsOf(initial.scope);
			if (old && typeof old === 'object' && initial.label in old) await settings.set(AGENTS_ID, withoutQuickCommand(old, initial.label), initial.scope);
		}
		if (kind !== 'prompt') return;
		const current = withoutQuickCommand(agentsOf(scope), label.trim());
		const nextAgents = agent ? { ...current, [label.trim()]: agent } : current;
		const before = agentsOf(scope);
		if (JSON.stringify(nextAgents) !== JSON.stringify(before && typeof before === 'object' ? before : {})) await settings.set(AGENTS_ID, nextAgents, scope);
	}

	/** A command's Insert mode next to it (same scope, same label), like a prompt's agent. */
	async function saveInsert() {
		const of = (s: Scope) => (s === 'repo' ? settings.repo.values : settings.user.values)[QUICK_INSERT_ID];
		if (initial?.kind === 'command' && (initial.label !== label.trim() || initial.scope !== scope || kind !== 'command')) {
			const old = of(initial.scope);
			if (old && typeof old === 'object' && initial.label in old) await settings.set(QUICK_INSERT_ID, withoutKey(old, initial.label), initial.scope);
		}
		if (kind !== 'command') return;
		const current = withoutKey(of(scope), label.trim());
		const next = appendEnter ? current : { ...current, [label.trim()]: true };
		const before = of(scope);
		if (JSON.stringify(next) !== JSON.stringify(before && typeof before === 'object' ? before : {})) await settings.set(QUICK_INSERT_ID, next, scope);
	}
	const withoutKey = (map: unknown, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(map && typeof map === 'object' ? (map as Record<string, unknown>) : {}).filter(([k]) => k !== key));

	async function save(e: Event) {
		e.preventDefault();
		if (saving) return;
		const layerOf = (s: Scope, k: Kind) => (s === 'repo' ? settings.repo.values : settings.user.values)[IDS[k]];
		// Editing: the old entry leaves where it was first (a new label, scope or action).
		const moved = initial && (initial.label !== label.trim() || initial.scope !== scope || initial.kind !== kind);
		const sameSlot = !!initial && initial.scope === scope && initial.kind === kind;
		const base = moved && sameSlot ? withoutQuickCommand(layerOf(scope, kind), initial.label) : layerOf(scope, kind);
		const next = withQuickCommand(base, label, command);
		if (typeof next === 'string') return void (problem = t(`legacyAde.quickCommand.problem.${next}`));
		saving = true;
		problem = '';
		try {
			await settings.set(IDS[kind], next, scope);
			if (moved && !sameSlot) await settings.set(IDS[initial.kind], withoutQuickCommand(layerOf(initial.scope, initial.kind), initial.label), initial.scope);
			await saveAgent();
			await saveInsert();
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
	<form class="w-[460px] max-w-[calc(100vw-32px)] space-y-3 rounded-lg border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) p-4 text-[13px] shadow-xl" aria-label={initial ? t('legacyAde.quickCommand.editTitle') : t('legacyAde.quickCommand.title')} onsubmit={save} onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onclose())}>
		<div>
			<h2 class="font-semibold">{initial ? t('legacyAde.quickCommand.editTitle') : t('legacyAde.quickCommand.title')}</h2>
			<p class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.hint')}</p>
		</div>
		<fieldset class="space-y-1">
			<legend class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.action')}</legend>
			<div class="flex gap-4">
				<label class="flex items-center gap-1.5"><input type="radio" name="kind" value="command" bind:group={kind} disabled={saving} />{t('legacyAde.quickCommand.command')}</label>
				<label class="flex items-center gap-1.5"><input type="radio" name="kind" value="prompt" bind:group={kind} disabled={saving} />{t('legacyAde.quickCommand.prompt')}</label>
			</div>
		</fieldset>
		<label class="block space-y-1">
			<span class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.label')}</span>
			<input bind:this={first} class={INPUT} placeholder={t('legacyAde.quickCommand.labelPlaceholder')} bind:value={label} disabled={saving} />
		</label>
		<label class="block space-y-1">
			<span class="text-xs text-(--vscode-descriptionForeground)">{kind === 'prompt' ? t('legacyAde.quickCommand.promptText') : t('legacyAde.quickCommand.commandText')}</span>
			<textarea class={[INPUT, 'h-20 resize-y', kind === 'command' && 'font-mono']} placeholder={kind === 'prompt' ? t('legacyAde.quickCommand.promptPlaceholder') : 'bun run dev'} bind:value={command} disabled={saving} spellcheck={kind === 'prompt'}></textarea>
		</label>
		{#if kind === 'command'}
			<label class="flex items-start gap-2">
				<input type="checkbox" class="mt-0.5" bind:checked={appendEnter} disabled={saving} />
				<span>
					<span class="block">{t('legacyAde.quickCommand.appendEnter')}</span>
					<span class="block text-[11px] text-(--vscode-descriptionForeground)">{appendEnter ? t('legacyAde.quickCommand.appendEnterOn') : t('legacyAde.quickCommand.appendEnterOff')}</span>
				</span>
			</label>
		{/if}
		{#if kind === 'prompt'}
			<label class="block space-y-1">
				<span class="text-xs text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.agent')}</span>
				<select class={INPUT} bind:value={agent} disabled={saving}>
					<option value="">{t('legacyAde.quickCommand.defaultAgent', { agent: defaultAgent })}</option>
					{#each agentRows as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
					{#if agent && !agentRows.some((r) => r.id === agent)}<option value={agent}>{agent}</option>{/if}
				</select>
				<span class="block text-[11px] text-(--vscode-descriptionForeground)">{t('legacyAde.quickCommand.promptHint')}</span>
			</label>
		{/if}
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
