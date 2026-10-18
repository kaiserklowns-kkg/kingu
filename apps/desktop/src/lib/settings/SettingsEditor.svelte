<script lang="ts">
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	// Simplified VS Code Settings editor (settingsEditor2): search, User/Workspace scope tabs,
	// grouped settings with a control per type, and a jump to the settings.json being edited.
	// `group` narrows it to one group (the system settings page's table of contents); a search
	// always spans every group.
	import Icon from '#lib/workbench/Icon.svelte';
	import { commands } from '#lib/workbench/commands.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { allowedIn, mergesByKey, scopeRule, settingsInView, settingSubgroup, settingTitle, SUBGROUPS, validate, type SettingSchema, type SettingScope } from './registry';
	import { schemaChoices } from './jsonSchema';
	import PopupMenu, { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
	import { settings } from './settings.svelte';
	import { settingSchemas } from './schemas.svelte';
	import ListSetting from './ListSetting.svelte';

	// Repository: Kingu's per-repository overrides of the open folder (Orca's per-repo settings),
	// kept in the app config dir, highest precedence.
	const SCOPES = $derived<[SettingScope, string][]>([['user', 'User'], ['workspace', 'Workspace'], ...(workspace.root ? ([['repo', 'Repository']] as [SettingScope, string][]) : [])]);
	const SCOPE_LABEL: Record<SettingScope, string> = { user: 'User', workspace: 'Workspace', repo: 'Repository' };
	/** The layers under each scope, nearest first (what a scope inherits). */
	const BELOW: Record<SettingScope, SettingScope[]> = { user: [], workspace: ['user'], repo: ['workspace', 'user'] };

	let { group = null, query = $bindable('') }: { group?: string | null; query?: string } = $props();
	let scope = $state<SettingScope>('user');
	$effect(() => {
		if (scope === 'repo' && !workspace.root) scope = 'user';
	});

	const isModified = (id: string) => (['user', 'workspace', 'repo'] as const).some((sc) => settings.inspect(id, sc) !== undefined);
	const visible = $derived(settingsInView(query, group, settingSchemas.all, isModified));
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
		const out = new Map<string, Map<string | null, SettingSchema[]>>();
		for (const s of visible) {
			const subs = out.get(s.group) ?? new Map<string | null, SettingSchema[]>([[null, []]]);
			out.set(s.group, subs);
			const sub = settingSubgroup(s);
			subs.set(sub, [...(subs.get(sub) ?? []), s]);
		}
		const order = (group: string) => [null, ...(SUBGROUPS[group] ?? []).map(([label]) => label)];
		return [...out].map(([group, subs]) => [group, order(group).flatMap((sub) => (subs.get(sub)?.length ? [[sub, subs.get(sub)!] as const] : []))] as const);
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

<div class="flex h-full flex-col bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<div class="mx-auto flex w-full max-w-[1000px] shrink-0 flex-col gap-2 px-6 pt-3">
		<div class="flex items-center gap-2">
			<label class="relative flex min-w-0 flex-1 items-center">
			<span class="pointer-events-none absolute left-2.5 text-(--vscode-input-placeholderForeground)"><Icon name="search" size={15} /></span>
			<input
				bind:value={query}
				aria-label="ค้นหาการตั้งค่า"
				placeholder="ค้นหาการตั้งค่า (Search settings)"
				class="h-8 min-w-0 flex-1 rounded-md border pl-8 border-(--vscode-input-border) bg-(--vscode-input-background) pr-2 text-sm text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)"
			/>
			</label>
			<button
				title="Open Settings (JSON)"
				aria-label="Open Settings (JSON)"
				class="grid size-7 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)"
				onclick={openJson}><Icon name="goToFile" /></button
			>
		</div>
		<div role="tablist" aria-label="ขอบเขตการตั้งค่า" class="flex gap-4 border-b border-(--vscode-widget-border,var(--vscode-panel-border)) text-[13px]">
			{#each SCOPES as [id, label] (id)}
				<button
					role="tab"
					aria-selected={scope === id}
					class={[
						'-mb-px border-b px-1 pb-1.5 uppercase',
						scope === id ? 'border-(--vscode-panelTitle-activeBorder) text-(--vscode-panelTitle-activeForeground)' : 'border-transparent text-(--vscode-panelTitle-inactiveForeground) hover:text-(--vscode-panelTitle-activeForeground)'
					]}
					onclick={() => (scope = id)}>{label}</button
				>
			{/each}
			<span class="ml-auto self-center truncate pb-1.5 text-xs text-(--vscode-descriptionForeground)" title={layer.path}>{layer.path}</span>
		</div>
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
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-[1000px] px-6 pb-8">
			{#each groups as [group, subs] (group)}
				<h2 class="mt-5 mb-1 text-lg font-semibold text-(--vscode-settings-headerForeground)">{group}</h2>
				{#each subs as [sub, list] (sub ?? '')}
				{#if sub}<h3 class="mt-4 mb-1 text-[15px] font-semibold text-(--vscode-settings-headerForeground)">{sub}</h3>{/if}
				{#each list as s (s.id)}
					{@const title = settingTitle(s)}
					{@const value = shown(s)}
					{@const disabled = !allowedIn(s, scope)}
					<div class={['group/setting relative rounded-md py-2 pr-2 pl-4 hover:bg-(--vscode-list-hoverBackground)/50', modifiedHere(s) && 'rounded-l-none border-l-2 border-(--vscode-settings-modifiedItemIndicator) pl-[14px]']}>
						<div class="flex items-center gap-2 text-[13px]">
							<span><span class="text-(--vscode-descriptionForeground)">{title.category}:</span> <span class="font-semibold">{title.label}</span></span>
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
						<div class="mt-0.5 text-[11px] text-(--vscode-descriptionForeground) opacity-80">{s.id}</div>
						{#if s.type === 'boolean'}
							<label class="mt-1 flex items-start gap-2 text-[13px] text-(--vscode-descriptionForeground)">
								<input
									type="checkbox"
									class="mt-0.5 size-[18px] shrink-0 accent-(--vscode-focusBorder)"
									checked={value === true}
									{disabled}
									onchange={(e) => update(s, e.currentTarget.checked)}
								/>
								<span>{s.description}</span>
							</label>
						{:else}
							<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">{s.description}</p>
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
									{#if i >= 0 && s.enumDescriptions[i]}<p class="mt-1 text-xs text-(--vscode-descriptionForeground)">{s.enumDescriptions[i]}</p>{/if}
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

{#if gear}
	{@const target = gear.s}
	<PopupMenu items={gearItems} label="Setting" x={gear.x} y={gear.y} onRun={(node) => node.type === 'item' && runGear(node.id, target)} onClose={() => (gear = null)} />
{/if}

