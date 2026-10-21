<script lang="ts">
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	// Simplified VS Code Settings editor (settingsEditor2): search, User/Workspace scope tabs,
	// grouped settings with a control per type, and a jump to the settings.json being edited.
	// `group` narrows it to one group (the system settings page's table of contents); a search
	// spans every group unless a group is picked. `pane` shows groups as an Orca settings pane
	// instead (title and description, one card, label left / control right) in one fixed scope.
	import Icon from '#lib/workbench/Icon.svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { allowedIn, inTocSelection, matchesQuery, mergesByKey, parseQuery, scopeRule, settingsInView, settingSubgroup, settingTitle, SUBGROUPS, validate, type SettingSchema, type SettingScope } from './registry';
	import { schemaChoices } from './jsonSchema';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { settings } from './settings.svelte';
	import { settingSchemas } from './schemas.svelte';
	import ListSetting from './ListSetting.svelte';
	import SettingDescription from './SettingDescription.svelte';
	import Toggle from './Toggle.svelte';
	import type { Snippet } from 'svelte';
	import { locale, t } from '#lib/i18n/index.ts';
	import { paneLabel, paneText } from './panes';

	// Repository: Kingu's per-repository overrides of the open folder (Orca's per-repo settings),
	// kept in the app config dir, highest precedence.
	const SCOPES = $derived<[SettingScope, string][]>([['user', 'User'], ['workspace', 'Workspace'], ...(workspace.root ? ([['repo', 'Repository']] as [SettingScope, string][]) : [])]);
	const SCOPE_LABEL: Record<SettingScope, string> = { user: 'User', workspace: 'Workspace', repo: 'Repository' };
	/** The layers under each scope, nearest first (what a scope inherits). */
	const BELOW: Record<SettingScope, SettingScope[]> = { user: [], workspace: ['user'], repo: ['workspace', 'user'] };

	/** `exclude`: ids (or `prefix.*`) a pane's own `lead` content edits instead of rows. */
	type Pane = { title: string; description: string; groups: string[]; scope: SettingScope; exclude?: readonly string[] };
	let {
		group = null,
		query = $bindable(''),
		pane = null,
		hideSearch = false,
		bare = false,
		groups: pickedGroups = null,
		ids = null,
		heading = '',
		lead
	}: {
		group?: string | null;
		query?: string;
		pane?: Pane | null;
		hideSearch?: boolean;
		bare?: boolean;
		/** Several groups at once (a VS Code table-of-contents node such as Features). */
		groups?: readonly string[] | null;
		/** These settings in this order under `heading` (VS Code's Commonly Used). */
		ids?: readonly string[] | null;
		heading?: string;
		lead?: Snippet;
	} = $props();
	const excluded = (id: string) => pane?.exclude?.some((x) => (x.endsWith('.*') ? id.startsWith(x.slice(0, -1)) : id === x)) ?? false;
	let picked = $state<SettingScope>('user');
	$effect(() => {
		if (picked === 'repo' && !workspace.root) picked = 'user';
	});
	const scope = $derived(pane?.scope ?? picked);

	const isModified = (id: string) => (['user', 'workspace', 'repo'] as const).some((sc) => settings.inspect(id, sc) !== undefined);
	const visible = $derived.by(() => {
		if (pane) {
			const { groups, scope } = pane;
			const { filters, text } = parseQuery(query);
			return settingSchemas.all.filter((s) => groups.includes(s.group) && !excluded(s.id) && allowedIn(s, scope) && (!filters.modified || isModified(s.id)) && (!text || matchesQuery(s, text)));
		}
		if (ids) {
			const found = settingsInView(query, null, settingSchemas.all, isModified);
			return ids.flatMap((id) => found.filter((s) => s.id === id));
		}
		if (pickedGroups) return settingsInView(query, null, settingSchemas.all, isModified).filter((s) => pickedGroups.includes(s.group));
		const all = settingsInView(query, group, settingSchemas.all, isModified);
		// A group picked while searching narrows the results to it (Orca's search stays on the picked pane).
		return group && query.trim() ? all.filter((s) => inTocSelection(s, group)) : all;
	});
	const problemsOf = (id: string) => settings.problems.filter((p) => p.id === id && p.scope === scope);
	const scopeProblems = $derived(settings.problems.filter((p) => p.scope === scope));
	/** Theme pickers show the theme's label, other enums their value (like VS Code). */
	const labelled = (s: SettingSchema) => s.id.endsWith('ColorTheme');

	// The gear menu of a setting (VS Code: Reset Setting, Copy Setting ID, Copy Setting as JSON).
	let gear = $state<{ s: SettingSchema; x: number; y: number } | null>(null);
	const gearItems = $derived(
		gear
			? [menuItem('reset', 'Reset Setting', { enabled: settings.inspect(gear.s.id, scope) !== undefined }), menuSeparator, menuItem('copyId', 'Copy Setting ID'), menuItem('copyJson', 'Copy Setting as JSON')]
			: []
	);
	async function runGear(id: string, s: SettingSchema) {
		if (id === 'reset') return update(s, undefined);
		const text = id === 'copyId' ? s.id : `"${s.id}": ${JSON.stringify(shown(s))}`;
		await navigator.clipboard.writeText(text);
		status.flash(`คัดลอก ${text} แล้ว`, 3000);
	}

	/**
	 * Groups in registry order; inside a group its own settings first, then each VS Code sub-group
	 * (Text Editor › Cursor, Workbench › Breadcrumbs, …) under its own heading.
	 */
	const groups = $derived.by(() => {
		if (ids) return visible.length ? [[heading, [[null, visible]] as const] as const] : [];
		const out = new Map<string, Map<string | null, SettingSchema[]>>();
		for (const s of visible) {
			const subs = out.get(s.group) ?? new Map<string | null, SettingSchema[]>([[null, []]]);
			out.set(s.group, subs);
			const sub = settingSubgroup(s);
			subs.set(sub, [...(subs.get(sub) ?? []), s]);
		}
		const order = (group: string) => [null, ...(SUBGROUPS[group] ?? []).map(([label]) => label)];
		const byPane = (a: string, b: string) => (pane ? pane.groups.indexOf(a) - pane.groups.indexOf(b) : 0);
		return [...out].sort(([a], [b]) => byPane(a, b)).map(([group, subs]) => [group, order(group).flatMap((sub) => (subs.get(sub)?.length ? [[sub, subs.get(sub)!] as const] : []))] as const);
	});
	const layer = $derived(settings.layer(scope));

	/** What the control shows: the scope's own value, else what that scope inherits. */
	function shown(s: SettingSchema): unknown {
		const own = validate(s, settings.inspect(s.id, scope));
		const below = BELOW[scope].filter((sc) => allowedIn(s, sc)).map((sc) => validate(s, settings.inspect(s.id, sc)));
		// Object settings merge across layers (files.exclude adds to the defaults).
		if (mergesByKey(s)) return Object.assign({}, s.default, ...below.toReversed(), own);
		// `null` is a real value for some VS Code settings (search.maxResults: no limit).
		const inherited = below.find((v) => v !== undefined);
		return own !== undefined ? own : inherited !== undefined ? inherited : s.default;
	}

	const modifiedHere = (s: SettingSchema) => settings.inspect(s.id, scope) !== undefined;
	/** The other scopes that set this setting (and may). */
	const alsoIn = (s: SettingSchema) => (['user', 'workspace', 'repo'] as SettingScope[]).filter((sc) => sc !== scope && allowedIn(s, sc) && settings.inspect(s.id, sc) !== undefined);

	async function update(s: SettingSchema, value: unknown) {
		try {
			// Writing the default to the user file is the same as removing it, like VS Code.
			const remove = value === undefined || (scope === 'user' && JSON.stringify(value) === JSON.stringify(s.default));
			await settings.set(s.id, remove ? undefined : value, scope);
		} catch (e) {
			notifications.error(`บันทึกการตั้งค่าไม่สำเร็จ: ${e instanceof Error ? e.message : e}`);
		}
	}

	function onNumber(s: SettingSchema, el: HTMLInputElement) {
		const n = el.valueAsNumber;
		if (validate(s, n) === undefined) {
			status.flash(`${s.id}: ค่าไม่ถูกต้อง`);
			el.value = String(shown(s));
			return;
		}
		void update(s, n);
	}

	/** A dropdown value for a json setting's finite choices (`true`, `"active"`, `null` …). */
	const choiceKey = (v: unknown) => JSON.stringify(v);
	const choiceLabel = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

	/**
	 * VS Code's "Edit in settings.json" for values the editor has no control for: the key goes into
	 * this scope's file with the value in effect (unless it is already there), then the file opens.
	 */
	async function editInJson(s: SettingSchema) {
		if (!modifiedHere(s) && scope !== 'repo') {
			try {
				await settings.set(s.id, shown(s), scope);
			} catch (e) {
				notifications.error(`บันทึกการตั้งค่าไม่สำเร็จ: ${e instanceof Error ? e.message : e}`);
			}
		}
		openJson();
	}

	function openJson() {
		// The per-repository file lives in the app config dir: it is edited here only.
		if (scope === 'repo') {
			status.flash(`การตั้งค่า Repository เก็บที่ ${layer.path || 'config ของ Kingu'} — แก้ไขในหน้านี้`);
			return;
		}
		void commands.run(scope === 'user' ? 'workbench.action.openSettingsJson' : 'workbench.action.openWorkspaceSettingsFile');
	}
</script>

{#if pane && bare}
	<!-- Only the rows, inside another Orca pane (its "More" sub-section). -->
	{#each groups as [g, subs] (g)}
		<section aria-label={g} class="space-y-1">
			{#if pane.groups.length > 1}<h4 class="pt-2 text-xs font-medium text-(--vscode-descriptionForeground)">{g}</h4>{/if}
			{#each subs.flatMap(([, list]) => list) as s (s.id)}
				{@render paneRow(s)}
			{/each}
		</section>
	{/each}
{:else if pane}
	<div class="h-full overflow-y-auto bg-(--vscode-editor-background) text-(--vscode-foreground)">
		<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 pt-10 pb-24">
			<header class="flex flex-wrap items-start justify-between gap-4 border-b border-(--vscode-widget-border)/60 pb-5">
				<div class="min-w-0 space-y-2">
					<h1 class="text-2xl leading-tight font-semibold">{pane.title}</h1>
					<p class="max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">{pane.description}</p>
				</div>
				{@render jsonButton()}
			</header>
			{@render alerts()}
			{#if groups.length || (lead && !query.trim())}
				<!-- Orca's section body: one soft card; several groups become its sub-sections. -->
				<div class="space-y-8 rounded-xl border border-(--vscode-widget-border)/50 bg-(--vscode-sideBar-background)/50 px-7 py-6 shadow-xs">
					{#if lead && !query.trim()}
						{@render lead()}
						{#if groups.length}<hr class="border-(--vscode-widget-border)/60" />{/if}
					{/if}
					{#each groups as [g, subs] (g)}
						<section aria-label={g} class="space-y-2">
							{#if pane.groups.length > 1}<h3 class="text-sm font-semibold">{g}</h3>{/if}
							{#each subs.flatMap(([, list]) => list) as s (s.id)}
								{@render paneRow(s)}
							{/each}
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
{:else}
<div class="flex h-full flex-col bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<div class="mx-auto flex w-full max-w-[1000px] shrink-0 flex-col gap-2 px-6 pt-3">
		{#if !hideSearch}
		<div class="flex items-center gap-2">
			<label class="relative flex min-w-0 flex-1 items-center">
			<span class="pointer-events-none absolute left-2.5 text-(--vscode-input-placeholderForeground)"><Icon name="search" size={15} /></span>
			<!-- VS Code focuses the search box when the Settings editor opens. -->
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:value={query}
				autofocus
				aria-label="ค้นหาการตั้งค่า"
				placeholder="ค้นหาการตั้งค่า (Search settings)"
				class="h-8 min-w-0 flex-1 rounded-md border pl-8 border-(--vscode-input-border) bg-(--vscode-input-background) pr-2 text-sm text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
			/>
			</label>
			{@render jsonButton()}
		</div>
		{/if}
		<div role="tablist" aria-label="ขอบเขตการตั้งค่า" class="flex items-center gap-1.5 text-[13px]">
			{#each SCOPES as [id, label] (id)}
				<button
					role="tab"
					aria-selected={scope === id}
					class={[
						'rounded-md px-2.5 py-1',
						scope === id ? 'bg-(--vscode-list-inactiveSelectionBackground) font-medium text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground) hover:text-(--vscode-foreground)'
					]}
					onclick={() => (picked = id)}>{label}</button
				>
			{/each}
			<span class="ml-auto self-center truncate text-xs text-(--vscode-descriptionForeground)" title={layer.path}>{layer.path}</span>
			{#if hideSearch}{@render jsonButton()}{/if}
		</div>
		{@render alerts()}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-[1000px] px-6 pb-8">
			{#each groups as [group, subs] (group)}
				<h2 class="mt-7 mb-2 text-2xl leading-tight font-semibold text-(--vscode-settings-headerForeground)">{group}</h2>
				{#each subs as [sub, list] (sub ?? '')}
				{#if sub}<h3 class="mt-5 mb-1 text-lg font-semibold text-(--vscode-settings-headerForeground)">{sub}</h3>{/if}
				{#each list as s (s.id)}
					{@const title = settingTitle(s)}
					{@const value = shown(s)}
					{@const disabled = !allowedIn(s, scope)}
					<div class={['group/setting relative rounded-md py-2 pr-2 pl-4 hover:bg-(--vscode-list-hoverBackground)/50', modifiedHere(s) && 'rounded-l-none border-l-2 border-(--vscode-settings-modifiedItemIndicator) pl-[14px]']}>
						<div class="flex items-center gap-2 text-[13px]">
							<span title={s.id}><span class="font-semibold opacity-90">{title.category}:</span> <span class="font-bold">{title.label}</span></span>
							{#if alsoIn(s).length}
								<span class="text-xs text-(--vscode-descriptionForeground) italic">(Also modified in: {alsoIn(s).map((sc) => SCOPE_LABEL[sc]).join(', ')})</span>
							{/if}
							<span class="ml-auto flex items-center gap-2">
								{#if modifiedHere(s)}
									<button class="text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => update(s, undefined)}>Reset</button>
								{/if}
								<button
									class="grid size-6 place-items-center rounded-md text-(--vscode-descriptionForeground) opacity-0 group-hover/setting:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:opacity-100"
									aria-label="การทำงานของ {s.id}"
									title="More Actions…"
									aria-haspopup="menu"
									onclick={(e) => {
										const r = e.currentTarget.getBoundingClientRect();
										gear = { s, x: r.right - 248, y: r.bottom + 2 };
									}}><Icon name="settings" size={14} /></button
								>
							</span>
						</div>
						{#if s.type === 'boolean'}
							<label class="mt-1 flex items-start gap-2 text-[13px] text-(--vscode-descriptionForeground)">
								<input
									type="checkbox"
									class="mt-0.5 size-[18px] shrink-0 accent-(--vscode-focusBorder)"
									checked={value === true}
									{disabled}
									onchange={(e) => update(s, e.currentTarget.checked)}
								/>
								<span><SettingDescription text={s.description} onsetting={(id) => (query = `@id:${id}`)} /></span>
							</label>
						{:else}
							<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)"><SettingDescription text={s.description} onsetting={(id) => (query = `@id:${id}`)} /></p>
							{#if s.type === 'number'}
								<input
									type="number"
									class="mt-1.5 h-[26px] w-[200px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
									value={value as number}
									min={s.minimum}
									max={s.maximum}
									step={s.integer ? 1 : 'any'}
									{disabled}
									onchange={(e) => onNumber(s, e.currentTarget)}
								/>
							{:else if s.type === 'string' && s.enum}
								<select
									class="mt-1.5 h-[26px] min-w-[200px] rounded-sm border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1 text-[13px] text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)"
									value={value as string}
									{disabled}
									onchange={(e) => update(s, e.currentTarget.value)}
								>
									{#each s.enum as option, i (option)}
										<option value={option}>{s.enumDescriptions?.[i] && labelled(s) ? s.enumDescriptions[i] : option}</option>
									{/each}
								</select>
								{#if s.enumDescriptions && !labelled(s)}
									{@const i = s.enum.indexOf(value as string)}
									{#if i >= 0 && s.enumDescriptions[i]}<p class="mt-1 text-xs text-(--vscode-descriptionForeground)"><SettingDescription text={s.enumDescriptions[i]} onsetting={(id) => (query = `@id:${id}`)} /></p>{/if}
								{/if}
							{:else if s.type === 'array' || s.type === 'object'}
								<ListSetting schema={s} {value} {disabled} onchange={(v) => update(s, v)} />
							{:else if s.type === 'json'}
								{@const choices = schemaChoices(s.schema)}
								{#if choices}
									<select
										class="mt-1.5 h-[26px] min-w-[200px] rounded-sm border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1 text-[13px] text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)"
										value={choiceKey(value)}
										{disabled}
										onchange={(e) => update(s, choices.find((c) => choiceKey(c) === e.currentTarget.value))}
									>
										{#each choices as option (choiceKey(option))}
											<option value={choiceKey(option)}>{choiceLabel(option)}</option>
										{/each}
									</select>
								{:else}
									<div class="mt-1.5 flex max-w-[500px] items-center gap-2">
										<code class="min-w-0 flex-1 truncate rounded-sm bg-(--vscode-textCodeBlock-background) px-1.5 py-0.5 text-xs" title={JSON.stringify(value, null, 2)}>{JSON.stringify(value)}</code>
										<button class="shrink-0 text-xs text-(--vscode-textLink-foreground) hover:underline" {disabled} onclick={() => editInJson(s)}>Edit in settings.json</button>
									</div>
								{/if}
							{:else}
								<input
									type="text"
									class="mt-1.5 h-[26px] w-full max-w-[500px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
									value={value as string}
									{disabled}
									onchange={(e) => update(s, e.currentTarget.value)}
								/>
							{/if}
						{/if}
						{#each problemsOf(s.id) as p (p.message)}
							<p class="mt-1 text-xs text-(--vscode-editorWarning-foreground)">{p.message}</p>
						{/each}
						{#if disabled}
							<p class="mt-1 text-xs text-(--vscode-editorWarning-foreground)">{scopeRule(s)}</p>
						{/if}
					</div>
				{/each}
				{/each}
			{:else}
				<p class="mt-6 text-(--vscode-descriptionForeground)">ไม่พบการตั้งค่าที่ตรงกับ “{query}”</p>
			{/each}
		</div>
	</div>
</div>

{/if}

{#snippet jsonButton()}
	<button
		title={t('settings.page.openJson')}
		aria-label={t('settings.page.openJson')}
		class="grid size-7 shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
		onclick={openJson}><Icon name="goToFile" /></button
	>
{/snippet}

{#snippet alerts()}
		{#if scopeProblems.length}
			<p role="alert" class="rounded-sm border border-(--vscode-editorWarning-foreground) px-2 py-1 text-xs text-(--vscode-editorWarning-foreground)">
				มี {scopeProblems.length} ค่าใน settings.json ที่ใช้ไม่ได้และถูกละไว้: {scopeProblems.map((p) => p.id).join(', ')} (Invalid values fall back to the next layer.)
			</p>
		{/if}
		{#if layer.error}
			<p role="alert" class="rounded-sm border border-(--vscode-editorError-foreground) px-2 py-1 text-xs text-(--vscode-errorForeground)">
				อ่าน settings.json ไม่ได้ ({layer.error}) — ใช้ค่าล่าสุดที่อ่านได้ แก้ไฟล์ผ่าน Open Settings (JSON)
			</p>
		{/if}
{/snippet}

<!-- A setting in an Orca pane (its SettingsRow): label and description left, the control right;
     lists and maps take the full width below. -->
{#snippet paneRow(s: SettingSchema)}
	{@const value = shown(s)}
	{@const disabled = !allowedIn(s, scope)}
	{@const label = paneLabel(settingTitle(s).label)}
	{@const wide = s.type === 'array' || s.type === 'object'}
	<div class="group/setting py-3">
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="flex min-h-6 items-center gap-1.5 text-sm leading-none font-medium" title={s.id}>
					{#if modifiedHere(s)}<span class="size-1.5 shrink-0 rounded-full bg-(--vscode-settings-modifiedItemIndicator)"></span>{/if}
					<span class="truncate">{label}</span>
					{#if modifiedHere(s)}
						<button class="text-xs font-normal text-(--vscode-textLink-foreground) hover:underline" onclick={() => update(s, undefined)}>{t('settings.page.reset')}</button>
					{/if}
					<button
						class="grid size-6 place-items-center rounded-md text-(--vscode-descriptionForeground) opacity-0 group-hover/setting:opacity-100 hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:opacity-100"
						aria-label="การทำงานของ {s.id}"
						title="More Actions…"
						aria-haspopup="menu"
						onclick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							gear = { s, x: r.left, y: r.bottom + 2 };
						}}><Icon name="settings" size={14} /></button
					>
				</div>
				<p class="text-xs text-(--vscode-descriptionForeground) select-text" title={s.description}><SettingDescription text={paneText(s.description, locale())} onsetting={(id) => (query = `@id:${id}`)} /></p>
			</div>
			{#if !wide}
				<div class="shrink-0">
					{#if s.type === 'boolean'}
						<Toggle checked={value === true} {label} {disabled} onchange={(v) => update(s, v)} />
					{:else if s.type === 'number'}
						<input
							type="number"
							aria-label={label}
							class="w-[120px] h-[26px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
							value={value as number}
							min={s.minimum}
							max={s.maximum}
							step={s.integer ? 1 : 'any'}
							{disabled}
							onchange={(e) => onNumber(s, e.currentTarget)}
						/>
					{:else if s.type === 'string' && s.enum}
						<select aria-label={label} class="h-[26px] max-w-[260px] min-w-[160px] rounded-sm border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1 text-[13px] text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)" value={value as string} {disabled} onchange={(e) => update(s, e.currentTarget.value)}>
							{#each s.enum as option, i (option)}
								<option value={option} title={s.enumDescriptions?.[i]}>{option}</option>
							{/each}
						</select>
					{:else if s.type === 'json'}
						{@const choices = schemaChoices(s.schema)}
						{#if choices}
							<select
								aria-label={label}
								class="h-[26px] max-w-[260px] min-w-[160px] rounded-sm border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1 text-[13px] text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)"
								value={choiceKey(value)}
								{disabled}
								onchange={(e) => update(s, choices.find((c) => choiceKey(c) === e.currentTarget.value))}
							>
								{#each choices as option (choiceKey(option))}
									<option value={choiceKey(option)}>{choiceLabel(option)}</option>
								{/each}
							</select>
						{:else}
							<button class="text-xs text-(--vscode-textLink-foreground) hover:underline" {disabled} onclick={() => editInJson(s)}>Edit in settings.json</button>
						{/if}
					{:else}
						<input type="text" aria-label={label} class="w-[260px] h-[26px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 text-[13px] text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)" value={value as string} {disabled} onchange={(e) => update(s, e.currentTarget.value)} />
					{/if}
				</div>
			{/if}
		</div>
		{#if wide}
			<div class="mt-1"><ListSetting schema={s} {value} {disabled} quiet onchange={(v) => update(s, v)} /></div>
		{/if}
		{#each problemsOf(s.id) as p (p.message)}
			<p class="mt-1 text-xs text-(--vscode-editorWarning-foreground)">{p.message}</p>
		{/each}
		{#if disabled}
			<p class="mt-1 text-xs text-(--vscode-editorWarning-foreground)">{scopeRule(s)}</p>
		{/if}
	</div>
{/snippet}

{#if gear}
	{@const target = gear.s}
	<PopupMenu items={gearItems} label="Setting" x={gear.x} y={gear.y} onRun={(node) => node.type === 'item' && runGear(node.id, target)} onClose={() => (gear = null)} />
{/if}

