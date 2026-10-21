<script lang="ts">
	// Settings › Shortcuts, laid out like Orca's Shortcuts pane: who wins in a terminal, the
	// keybindings.json to edit, then a rail (search + status filters with counts) beside every
	// command with its keys. Double-click a row to run the command.
	import { commands, keyOf } from '#lib/workbench/commands.svelte.ts';
	import { keybindings } from '#lib/workbench/keybindings.svelte.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '../settings.svelte';
	import { systemSettings } from '../systemSettings.svelte';

	type Status = 'all' | 'modified' | 'unassigned';
	let query = $state('');
	let status = $state<Status>('all');

	const all = $derived(
		commands.all
			.filter((c) => c.palette !== false || keyOf(c))
			.map((c) => ({
				id: c.id,
				title: c.category ? `${c.category}: ${c.title}` : c.title,
				key: keyOf(c) ? keyLabel(keyOf(c)!) : '',
				modified: keybindings.user.added.has(c.id) || keybindings.user.removed.has(c.id)
			}))
			.sort((a, b) => a.title.localeCompare(b.title))
	);
	const inStatus = (r: (typeof all)[number], s: Status) => (s === 'modified' ? r.modified : s === 'unassigned' ? !r.key : true);
	const count = (s: Status) => all.filter((r) => inStatus(r, s)).length;
	const rows = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return all.filter((r) => inStatus(r, status) && (!q || r.title.toLowerCase().includes(q) || r.key.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)));
	});

	const terminalFirst = $derived(settings.get<boolean>('terminal.integrated.sendKeybindingsToShell') === true);
	async function setTerminalFirst(on: boolean) {
		try {
			await settings.set('terminal.integrated.sendKeybindingsToShell', on || undefined, 'user');
		} catch (e) {
			notifications.error(t('settings.agents.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	function run(id: string) {
		systemSettings.close();
		void commands.run(id);
	}

	const STATUSES: { id: Status; label: 'panes.shortcuts.all' | 'panes.shortcuts.modified' | 'panes.shortcuts.unassigned' }[] = [
		{ id: 'all', label: 'panes.shortcuts.all' },
		{ id: 'modified', label: 'panes.shortcuts.modified' },
		{ id: 'unassigned', label: 'panes.shortcuts.unassigned' }
	];
</script>

<div class="flex h-full flex-col">
	<div class="mx-auto flex w-full max-w-4xl shrink-0 flex-col gap-6 px-8 pt-10 pb-4">
		<header class="space-y-2 border-b border-(--vscode-widget-border)/60 pb-5">
			<h1 class="text-2xl leading-tight font-semibold">{t('panes.shortcuts.title')}</h1>
			<p class="max-w-3xl text-sm leading-6 text-(--vscode-descriptionForeground)">{t('panes.shortcuts.description')}</p>
		</header>
		<div class="space-y-1 rounded-xl border border-(--vscode-widget-border)/50 bg-(--vscode-sideBar-background)/50 px-7 py-4 shadow-xs">
			<div class="flex items-center justify-between gap-4 py-3">
				<div class="min-w-0 flex-1 space-y-1">
					<div class="text-sm leading-none font-medium">{t('panes.shortcuts.terminal')}</div>
					<p class="text-xs text-(--vscode-descriptionForeground)">{t('panes.shortcuts.terminalHint')}</p>
				</div>
				<select
					class="h-7 w-44 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1.5 text-xs text-(--vscode-dropdown-foreground) outline-none focus:border-(--vscode-focusBorder)"
					aria-label={t('panes.shortcuts.terminal')}
					value={terminalFirst ? 'terminal' : 'kingu'}
					onchange={(e) => setTerminalFirst(e.currentTarget.value === 'terminal')}
				>
					<option value="kingu">{t('panes.shortcuts.kinguFirst')}</option>
					<option value="terminal">{t('panes.shortcuts.terminalFirst')}</option>
				</select>
			</div>
			<div class="flex items-center justify-between gap-4 border-t border-(--vscode-widget-border)/40 py-3">
				<div class="min-w-0 flex-1 space-y-1">
					<div class="text-sm leading-none font-medium">{t('panes.shortcuts.file')}</div>
					<p class="text-xs text-(--vscode-descriptionForeground)">{t('panes.shortcuts.fileHint')}</p>
					{#if keybindings.error}<p class="text-xs text-(--vscode-errorForeground)">{keybindings.error}</p>{/if}
				</div>
				<button class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-3 text-xs hover:bg-(--vscode-list-hoverBackground)" onclick={() => run('workbench.action.openGlobalKeybindingsFile')}>
					<Icon name="goToFile" size={13} />{t('panes.shortcuts.editFile')}
				</button>
			</div>
		</div>
	</div>
	<div class="mx-auto grid min-h-0 w-full max-w-4xl flex-1 grid-cols-[14rem_1fr] gap-6 px-8 pb-6">
		<!-- The rail: search and the status filters with their counts. -->
		<div class="space-y-4">
			<label class="block space-y-1.5">
				<span class="text-xs font-medium">{t('panes.shortcuts.find')}</span>
				<span class="relative flex items-center">
					<span class="pointer-events-none absolute left-2.5 text-(--vscode-input-placeholderForeground)"><Icon name="search" size={14} /></span>
					<!-- svelte-ignore a11y_autofocus -->
					<input bind:value={query} autofocus placeholder={t('panes.shortcuts.findPlaceholder')} class="h-8 w-full rounded-md border border-(--vscode-input-border) bg-(--vscode-input-background) pr-2 pl-8 text-xs outline-none focus:border-(--vscode-focusBorder)" />
				</span>
			</label>
			<div class="space-y-1">
				<div class="text-xs font-medium">{t('panes.shortcuts.status')}</div>
				{#each STATUSES as s (s.id)}
					<button
						class={['flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-(--vscode-list-hoverBackground)', status === s.id && 'bg-(--vscode-list-inactiveSelectionBackground) font-medium']}
						aria-pressed={status === s.id}
						onclick={() => (status = s.id)}
					>
						<span>{t(s.label)}</span><span class="text-[11px] text-(--vscode-descriptionForeground)">{count(s.id)}</span>
					</button>
				{/each}
			</div>
		</div>
		<div class="min-h-0 overflow-y-auto rounded-xl border border-(--vscode-widget-border)/50">
			<table class="w-full border-separate border-spacing-0 text-[13px]">
				<thead class="sticky top-0 bg-(--vscode-editor-background) text-left text-xs text-(--vscode-descriptionForeground)">
					<tr>
						<th class="border-b border-(--vscode-widget-border)/60 py-2 pl-4 font-medium">{t('panes.shortcuts.command')}</th>
						<th class="w-48 border-b border-(--vscode-widget-border)/60 py-2 pr-4 font-medium">{t('panes.shortcuts.keys')}</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.id)}
						<tr class="group cursor-default hover:bg-(--vscode-list-hoverBackground)" ondblclick={() => run(r.id)} title={r.id}>
							<td class="py-1.5 pl-4">
								<span class="flex items-center gap-2">
									<span class="truncate">{r.title}</span>
									{#if r.modified}<span class="shrink-0 rounded border border-(--vscode-widget-border) px-1.5 text-[10px] text-(--vscode-foreground)/75">{t('panes.shortcuts.modified')}</span>{/if}
								</span>
							</td>
							<td class="py-1.5 pr-4">
								{#if r.key}
									<span class="flex gap-1">
										{#each r.key.split(' ') as chord, i (i)}
											<kbd class="rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorGroupHeader-tabsBackground) px-1.5 py-0.5 font-sans text-xs">{chord}</kbd>
										{/each}
									</span>
								{:else}<span class="text-(--vscode-descriptionForeground)">—</span>{/if}
							</td>
						</tr>
					{:else}
						<tr><td colspan="2" class="py-8 text-center text-(--vscode-descriptionForeground)">{t('panes.shortcuts.none')}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
