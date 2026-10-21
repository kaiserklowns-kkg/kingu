<script lang="ts">
	// An Orca settings pane drawn from its spec (orcaPane.ts): the pane title and description, one
	// card, sub-sections split by a separator, rows with the label and description left and the
	// control right. Values are the Kingu settings the rows name, written to the user settings
	// (writing the default removes the key). A search keeps the rows whose words match.
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { isMessageKey, t } from '#lib/i18n/index.ts';
	import { settings } from './settings.svelte';
	import { SCHEMA, validate, type SettingScope } from './registry';
	import { switchOn, type OrcaPaneSpec, type PaneRow, type PaneSection } from './orcaPane';
	import Toggle from './Toggle.svelte';
	import Segmented from './Segmented.svelte';
	import ListSetting from './ListSetting.svelte';
	import SettingsEditor from './SettingsEditor.svelte';
	import CliSetting from './pages/CliSetting.svelte';
	import SupportSetting from './pages/SupportSetting.svelte';
	import ThemeGrid from './pages/ThemeGrid.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { PANE_SETTING_IDS } from './orcaPane';
	import { settingSchemas } from './schemas.svelte';
	import { AGENT_CATALOG_IDS } from './panes';

	const PANE_COMPONENTS = { cli: CliSetting, support: SupportSetting, themes: ThemeGrid };
	const EXCLUDE = [...PANE_SETTING_IDS, ...AGENT_CATALOG_IDS];
	const restCount = (groups: readonly string[]) => settingSchemas.all.filter((s) => groups.includes(s.group) && !EXCLUDE.includes(s.id)).length;

	/** `scope`: where values are read and written (the project pane uses the repository scope); `title` / `description`: text instead of the spec's. */
	let {
		spec,
		query = '',
		scope = 'user',
		title,
		description
	}: { spec: OrcaPaneSpec; query?: string; scope?: SettingScope; title?: string; description?: string } = $props();
	/** A row's value: this scope's own, else what applies (the user or default value). */
	const valueOf = (id: string) => (scope === 'user' ? settings.get(id) : (settings.inspect(id, scope) ?? settings.get(id)));

	const words = $derived(query.trim().toLowerCase());
	const matches = (...keys: (string | undefined)[]) => !words || keys.some((k) => k && t(k as never).toLowerCase().includes(words));
	const rowsOf = (sec: PaneSection) => (sec.rows ?? []).filter((r) => (!r.when || r.when(valueOf)) && (matches(sec.title, sec.hint) || matches(r.label, r.hint)));
	// A sub-section with no rows (rows: []) is text only, like Orca's how-to blocks.
	const shown = $derived(
		spec.sections.filter((sec) =>
			sec.rest ? restCount(sec.rest) > 0 : (sec.component || sec.rows?.length === 0) && matches(sec.title, sec.hint) ? true : rowsOf(sec).length > 0
		)
	);

	const key = (v: unknown) => JSON.stringify(v);
	/** Collapsed cards of a `cards` pane (all open at first, like Orca). */
	let closed = $state(new Set<number>());
	/** A choice says its message, or its name as it is (a sound, an agent CLI). */
	const say = (label: string) => (isMessageKey(label) ? t(label as never) : label);

	async function save(id: string, value: unknown) {
		const schema = SCHEMA.get(id);
		if (schema && value !== undefined && validate(schema, value) === undefined) return;
		// The user scope drops a default value; another scope drops only an emptied one (its own override).
		const drop = scope === 'user' ? !!schema && key(value) === key(schema.default) : value === '' || (Array.isArray(value) && !value.length);
		try {
			await settings.set(id, drop ? undefined : value, scope);
		} catch (e) {
			notifications.error(t('settings.agents.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	const INPUT = 'h-7 rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';
	const SELECT = 'h-7 min-w-40 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1.5 text-xs text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)';
</script>

{#snippet sectionBody(sec: PaneSection)}
						{#if sec.component}
							{@const Part = PANE_COMPONENTS[sec.component]}
							<Part />
						{/if}
						{#if sec.rest}
							<SettingsEditor bare pane={{ title: '', description: '', groups: [...sec.rest], scope: 'user', exclude: EXCLUDE }} {query} />
						{:else}
							{#each rowsOf(sec) as r (r.id)}
								{@const schema = SCHEMA.get(r.id)}
								<div class="py-3" title={r.id}>
									<div class="flex items-center justify-between gap-4">
										<div class="min-w-0 flex-1 space-y-1">
											<div class="text-sm leading-none font-medium">{t(r.label)}</div>
											{#if r.hint}<p class="text-xs text-(--vscode-descriptionForeground) select-text">{t(r.hint)}</p>{/if}
										</div>
										{#if r.kind !== 'list' && r.kind !== 'textarea'}<div class="shrink-0">{@render control(r)}</div>{/if}
									</div>
									{#if r.kind === 'textarea'}
										<textarea
											class="mt-2 min-h-20 w-full resize-y rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 py-1.5 font-mono text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
											aria-label={t(r.label)}
											spellcheck="false"
											placeholder={r.placeholder}
											value={(valueOf(r.id) as string) ?? ''}
											onchange={(e) => save(r.id, e.currentTarget.value)}
										></textarea>
									{/if}
									{#if r.kind === 'list' && schema && (schema.type === 'array' || schema.type === 'object')}
										<div class="mt-1"><ListSetting quiet {schema} value={valueOf(r.id)} onchange={(v) => save(r.id, v)} /></div>
									{/if}
								</div>
							{/each}
						{/if}
{/snippet}

{#snippet control(r: PaneRow)}
	{@const value = valueOf(r.id)}
	{#if r.kind === 'switch'}
		<Toggle checked={switchOn(r, value)} label={t(r.label)} onchange={(on) => save(r.id, r.on === undefined ? on : on ? r.on : r.off)} />
	{:else if r.kind === 'segmented'}
		<Segmented value={key(value)} label={t(r.label)} options={r.choices.map((c) => ({ value: key(c.value), label: say(c.label) }))} onchange={(v) => save(r.id, JSON.parse(v))} />
	{:else if r.kind === 'select'}
		<select class={SELECT} aria-label={t(r.label)} value={key(value)} onchange={(e) => save(r.id, JSON.parse(e.currentTarget.value))}>
			{#each r.choices as c (key(c.value))}<option value={key(c.value)}>{say(c.label)}</option>{/each}
		</select>
	{:else if r.kind === 'number'}
		<span class="inline-flex items-center gap-1.5">
			<input
				type="number"
				class={[INPUT, 'w-24']}
				aria-label={t(r.label)}
				value={value as number}
				min={r.min}
				max={r.max}
				step={r.step ?? 'any'}
				onchange={(e) => {
					const n = e.currentTarget.valueAsNumber;
					if (Number.isFinite(n) && (r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max)) void save(r.id, n);
					else e.currentTarget.value = String(value);
				}}
			/>
			{#if r.unit}<span class="text-xs text-(--vscode-descriptionForeground)">{r.unit}</span>{/if}
		</span>
	{:else if r.kind === 'text'}
		<input class={[INPUT, 'w-64']} aria-label={t(r.label)} value={(value as string) ?? ''} placeholder={r.placeholder} onchange={(e) => save(r.id, e.currentTarget.value)} />
	{/if}
{/snippet}

<div class="h-full overflow-y-auto bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 pt-10 pb-24">
		<header class="space-y-2 border-b border-(--vscode-widget-border)/60 pb-5">
			<h1 class="text-2xl leading-tight font-semibold">{title ?? t(spec.title)}</h1>
			<p class="max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">{description ?? t(spec.description)}</p>
		</header>
		{#if shown.length && spec.layout === 'cards'}
			<!-- Orca's Appearance: one collapsible card per sub-section; a search opens the matching ones. -->
			<div class="space-y-2.5">
				{#each shown as sec, i (sec.title ?? i)}
					{@const open = !!words || !closed.has(i)}
					<section class={['rounded-xl border bg-(--vscode-sideBar-background)/50 transition-colors', open ? 'border-(--vscode-focusBorder)/40' : 'border-(--vscode-widget-border)/50']}>
						<button
							class="flex w-full items-center gap-3 px-5 py-4 text-left disabled:cursor-default"
							aria-expanded={open}
							disabled={!!words}
							onclick={() => {
								const next = new Set(closed);
								if (next.has(i)) next.delete(i);
								else next.add(i);
								closed = next;
							}}
						>
							<span class="grid size-8 shrink-0 place-items-center rounded-md bg-(--vscode-editor-background)"><Icon name={sec.icon ?? 'sliders'} size={16} /></span>
							<span class="flex-1 text-sm font-semibold">{sec.title ? t(sec.title) : ''}</span>
							<span class={['grid place-items-center text-(--vscode-descriptionForeground) transition-transform', open && 'rotate-90']}><Icon name="chevronRight" size={14} /></span>
						</button>
						{#if open}
							<div class="space-y-2 border-t border-(--vscode-widget-border)/50 px-7 py-5">{@render sectionBody(sec)}</div>
						{/if}
					</section>
				{/each}
			</div>
		{:else if shown.length}
			<div class="rounded-xl border border-(--vscode-widget-border)/50 bg-(--vscode-sideBar-background)/50 px-7 py-6 shadow-xs">
				{#each shown as sec, i (sec.title ?? i)}
					{#if i}<hr class="my-6 border-(--vscode-widget-border)/60" />{/if}
					<section class="space-y-2">
						{#if sec.title}
							<div class="space-y-1">
								<h3 class="text-sm font-semibold">{t(sec.title)}</h3>
								{#if sec.hint}<p class="text-xs text-(--vscode-descriptionForeground)">{t(sec.hint)}</p>{/if}
							</div>
						{/if}
						{@render sectionBody(sec)}
					</section>
				{/each}
			</div>
		{:else}
			<p class="flex min-h-96 items-center justify-center rounded-2xl border border-dashed border-(--vscode-widget-border)/60 text-sm text-(--vscode-descriptionForeground)">
				{t('settings.page.noMatches', { query: query.trim() })}
			</p>
		{/if}
	</div>
</div>
