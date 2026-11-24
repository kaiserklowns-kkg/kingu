<script lang="ts">
	// A Linear, Jira or GitLab issue beside the Issues list (Orca's linear-item-drawer and Jira /
	// GitLab item views): its state, labels, assignees, description and latest comments, a comment
	// box, a status picker (Linear's workflow states, Jira's transitions, GitLab's close / reopen;
	// Orca's status controls), and Open in the browser for what the drawer does not change. The
	// folder's GitHub issues have IssueDrawer.svelte with more editing.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT } from './ui';
	import type { IssueLink } from './model';
	import { commentOnLink, gitlabHost, openLink } from './trackerApi';
	import { gitlabChoices, matchPeople, stateCalls, trackerDetail, viewCall, type StateChoice, type TrackerDetail } from './trackerDetail';
	import { isoTime, sourceName } from './taskSources';
	import { timeAgo } from './model';
	import { adeTasks } from './tasks.svelte';

	let { link, ref, onclose }: { link: IssueLink; ref: string; onclose: () => void } = $props();

	let detail = $state<TrackerDetail | null>(null);
	let error = $state('');
	let busy = $state(false);
	let comment = $state('');
	const service = $derived(sourceName(link));

	let choices = $state<StateChoice[]>([]);
	let moving = $state(false);
	const calls = $derived(stateCalls(link, gitlabHost()));
	async function load() {
		error = '';
		const call = viewCall(link, gitlabHost());
		if (!call) return void (error = t('adeSources.drawer.cannotRead', { service }));
		try {
			detail = trackerDetail(await invoke(call.cmd, call.args));
		} catch (e) {
			error = String(e);
			return;
		}
		const c = calls;
		if (!c) return void (choices = []);
		if (c.gitlab) return void (choices = gitlabChoices(detail.state, { close: t('adeSources.drawer.close'), reopen: t('adeSources.drawer.reopen') }));
		try {
			choices = c.list ? await invoke<StateChoice[]>(c.list.cmd, c.list.args) : [];
		} catch {
			// The status picker is an extra: the drawer still reads and comments without it.
			choices = [];
		}
	}
	/** One change of the issue (status, assignee, priority), then the drawer reads it again. */
	async function change(call: { cmd: string; args: Record<string, unknown> } | null | undefined) {
		if (!call || moving) return;
		moving = true;
		error = '';
		try {
			await invoke(call.cmd, call.args);
			await load();
		} catch (e) {
			error = String(e);
		} finally {
			moving = false;
		}
	}
	// Labels (Orca's label chips): Linear's team labels, or a typed name for Jira and GitLab.
	let teamLabels = $state<StateChoice[]>([]);
	let newLabel = $state('');
	async function loadLabels() {
		const c = calls?.labels;
		teamLabels = [];
		if (!c?.list) return;
		try {
			teamLabels = await invoke<StateChoice[]>(c.list.cmd, c.list.args);
		} catch {
			// Labels stay read-only without the list.
		}
	}
	$effect(() => {
		void link.url;
		void loadLabels();
	});
	async function removeLabel(name: string) {
		const c = calls?.labels;
		if (!c) return;
		if (c.byName) return change(c.edit({ add: [], remove: [name] }));
		const ids = teamLabels.filter((l) => l.current && l.name !== name).map((l) => l.id);
		await change(c.edit({ add: [], remove: [], ids }));
		await loadLabels();
	}
	async function addLabel(value: string) {
		const c = calls?.labels;
		const v = value.trim();
		if (!c || !v) return;
		if (c.byName) {
			await change(c.edit({ add: [v], remove: [] }));
			newLabel = '';
			return;
		}
		const ids = [...teamLabels.filter((l) => l.current).map((l) => l.id), v];
		await change(c.edit({ add: [], remove: [], ids }));
		await loadLabels();
	}
	// Assign anyone (Orca's assignee pickers): Linear's team members and GitLab's project members
	// are read once and filtered here; Jira searches its assignable users as the user types.
	let people = $state<StateChoice[]>([]);
	let peopleQuery = $state('');
	let peopleOpen = $state(false);
	let peopleLoading = $state(false);
	let peopleRead = $state(false);
	let peopleSeq = 0;
	async function loadPeople(query: string) {
		const c = calls?.people;
		if (!c) return;
		const seq = ++peopleSeq;
		peopleLoading = true;
		try {
			const call = c.list(query);
			const found = await invoke<StateChoice[]>(call.cmd, call.args);
			if (seq === peopleSeq) [people, peopleRead] = [found, true];
		} catch (e) {
			// Read stays true so a failing list is not asked again until the next change.
			if (seq === peopleSeq) [people, peopleRead, error] = [[], true, String(e)];
		} finally {
			if (seq === peopleSeq) peopleLoading = false;
		}
	}
	$effect(() => {
		void link.url;
		[people, peopleQuery, peopleOpen, peopleRead] = [[], '', false, false];
	});
	$effect(() => {
		// Jira asks the server for each search (after a pause in typing); the others read the list on opening.
		const q = peopleQuery;
		if (!peopleOpen || !calls?.people) return;
		if (!calls.people.searches) return void (peopleRead || peopleLoading ? undefined : loadPeople(''));
		const timer = setTimeout(() => void loadPeople(q.trim()), 250);
		return () => clearTimeout(timer);
	});
	const shownPeople = $derived(calls?.people.searches ? people.slice(0, 20) : matchPeople(people, peopleQuery));
	async function choosePerson(p: StateChoice) {
		peopleOpen = false;
		peopleQuery = '';
		await change(calls?.people.choose(p));
		peopleRead = false;
	}
	// Jira's priorities (the site's list, Orca's `listPriorities`), read once per drawer.
	let jiraPriorities = $state<StateChoice[]>([]);
	$effect(() => {
		const c = calls?.jiraPriority;
		jiraPriorities = [];
		if (c) void invoke<StateChoice[]>(c.list.cmd, c.list.args).then((p) => (jiraPriorities = p), () => {});
	});
	let estimateText = $state('');
	$effect(() => {
		estimateText = detail?.estimate === null || detail?.estimate === undefined ? '' : String(detail.estimate);
	});
	function saveEstimate() {
		const v = estimateText.trim();
		const n = v === '' ? null : Number(v);
		if (n !== null && (!Number.isInteger(n) || n < 0 || n > 1000)) return void (error = t('adeSources.drawer.badEstimate'));
		if (n === (detail?.estimate ?? null)) return;
		void change(calls?.estimate?.(n));
	}
	const PRIORITIES = $derived([t('adeSources.drawer.priorityNone'), t('adeSources.drawer.priorityUrgent'), t('adeSources.drawer.priorityHigh'), t('adeSources.drawer.priorityMedium'), t('adeSources.drawer.priorityLow')]);
	async function move(id: string) {
		const c = calls;
		if (!c || !id || moving) return;
		moving = true;
		error = '';
		try {
			const call = c.set(id);
			await invoke(call.cmd, call.args);
			await load();
		} catch (e) {
			error = String(e);
		} finally {
			moving = false;
		}
	}
	$effect(() => {
		void link.url;
		detail = null;
		void load();
	});
	async function send(e: Event) {
		e.preventDefault();
		if (!comment.trim() || busy) return;
		busy = true;
		error = '';
		try {
			await commentOnLink(link, comment);
			comment = '';
			await load();
		} catch (err) {
			error = String(err);
		} finally {
			busy = false;
		}
	}
	const when = (iso: string) => {
		const at = isoTime(iso);
		return at ? timeAgo(at, adeTasks.now) : '';
	};
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape anywhere in the drawer) -->
<aside class="flex h-full w-[420px] max-w-full shrink-0 flex-col border-l border-(--vscode-widget-border) bg-(--vscode-sideBar-background) text-xs" aria-label={t('adeSources.drawer.trackerTitle', { ref })} onkeydown={(e) => e.key === 'Escape' && onclose()}>
	<header class="flex shrink-0 items-start gap-2 border-b border-(--vscode-widget-border) px-3 py-2">
		<div class="min-w-0 flex-1">
			<p class="font-mono text-(--vscode-descriptionForeground)">{ref} · {service}</p>
			<h2 class="text-[13px] font-semibold break-words">{detail?.title || link.title}</h2>
		</div>
		<button class={ICON_BUTTON} aria-label={t('adeSources.openOn', { ref, service })} title={t('adeSources.openOn', { ref, service })} onclick={() => void openLink(link).catch((e) => (error = String(e)))}><Icon name="openExternal" size={14} /></button>
		<button class={ICON_BUTTON} aria-label={t('common.close')} title={t('common.close')} onclick={onclose}><Icon name="close" size={14} /></button>
	</header>
	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
		{#if error}<p class="rounded border border-(--vscode-errorForeground) px-2 py-1 text-(--vscode-errorForeground)" role="alert">{error}</p>{/if}
		{#if !detail}
			{#if !error}<p class="text-(--vscode-descriptionForeground)">{t('adeSources.drawer.loading')}</p>{/if}
		{:else}
			<div class="flex flex-wrap items-center gap-1.5">
				{#if detail.state}<span class="rounded-full bg-(--vscode-badge-background)/60 px-2 leading-5 text-(--vscode-badge-foreground)">{detail.state}</span>{/if}
				{#if choices.some((c) => !c.current)}
					<select
						class="h-6 rounded-md border border-(--vscode-dropdown-border,var(--vscode-widget-border)) bg-(--vscode-dropdown-background) px-1 text-xs text-(--vscode-dropdown-foreground) disabled:opacity-50"
						aria-label={t('adeSources.drawer.moveTo')}
						title={t('adeSources.drawer.moveTo')}
						disabled={moving}
						value=""
						onchange={(e) => {
							const id = e.currentTarget.value;
							e.currentTarget.value = '';
							void move(id);
						}}
					>
						<option value="" disabled>{moving ? t('adeSources.drawer.moving') : t('adeSources.drawer.moveTo')}</option>
						{#each choices.filter((c) => !c.current) as c (c.id)}
							<option value={c.id} disabled={c.needs_fields} title={c.needs_fields ? t('adeSources.drawer.needsFields', { service }) : undefined}>{c.needs_fields ? t('adeSources.drawer.needsFieldsName', { name: c.name }) : c.name}</option>
						{/each}
					</select>
				{/if}
				{#each detail.labels as l (l.name)}
					<span class="flex items-center gap-0.5 rounded-full border pr-0.5 pl-1.5 text-[11px] leading-4" style:border-color={/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : undefined}
						>{l.name}{#if calls && (calls.labels.byName || teamLabels.length)}<button class="grid size-3.5 place-items-center rounded-full hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={t('adeSources.drawer.removeLabel', { label: l.name })} title={t('adeSources.drawer.removeLabel', { label: l.name })} disabled={moving} onclick={() => void removeLabel(l.name)}><Icon name="close" size={9} /></button>{/if}</span
					>
				{/each}
				{#if calls?.labels.byName}
					<input
						class="h-5 w-24 rounded-full border border-dashed border-(--vscode-widget-border) bg-transparent px-1.5 text-[11px] outline-none focus:border-(--vscode-focusBorder)"
						placeholder={t('adeSources.drawer.addLabel')}
						aria-label={t('adeSources.drawer.addLabel')}
						bind:value={newLabel}
						disabled={moving}
						onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), void addLabel(newLabel))}
					/>
				{:else if teamLabels.some((l) => !l.current)}
					<select
						class="h-5 rounded-full border border-dashed border-(--vscode-widget-border) bg-transparent px-1 text-[11px] text-(--vscode-foreground)"
						aria-label={t('adeSources.drawer.addLabel')}
						disabled={moving}
						value=""
						onchange={(e) => {
							const id = e.currentTarget.value;
							e.currentTarget.value = '';
							void addLabel(id);
						}}
					>
						<option value="" disabled>{t('adeSources.drawer.addLabel')}</option>
						{#each teamLabels.filter((l) => !l.current) as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
					</select>
				{/if}
				<span class="text-(--vscode-descriptionForeground)">{detail.assignees.length ? detail.assignees.join(', ') : t('adeSources.drawer.nobody')}</span>
			</div>
			{#if calls}
				<div class="flex flex-wrap items-center gap-1.5">
					<button class={BUTTON_SECONDARY} disabled={moving} onclick={() => void change(calls?.assign(true))}>{t('adeSources.drawer.assignMe')}</button>
					{#if detail.assignees.length}<button class={BUTTON_SECONDARY} disabled={moving} onclick={() => void change(calls?.assign(false))}>{t('adeSources.drawer.unassignAll')}</button>{/if}
					<div class="relative">
						<input
							class="h-6 w-36 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-1.5 text-xs text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
							placeholder={t('adeSources.drawer.assignTo')}
							aria-label={t('adeSources.drawer.assignTo')}
							role="combobox"
							aria-expanded={peopleOpen}
							aria-controls="tracker-people"
							autocomplete="off"
							bind:value={peopleQuery}
							disabled={moving}
							onfocus={() => (peopleOpen = true)}
							oninput={() => (peopleOpen = true)}
							onblur={() => (peopleOpen = false)}
							onkeydown={(e) => {
								if (e.key === 'Escape' && peopleOpen) (e.stopPropagation(), (peopleOpen = false));
								else if (e.key === 'Enter' && shownPeople.length === 1) (e.preventDefault(), void choosePerson(shownPeople[0]));
							}}
						/>
						{#if peopleOpen}
							<ul id="tracker-people" role="listbox" aria-label={t('adeSources.drawer.assignTo')} class="absolute top-7 left-0 z-10 max-h-56 w-60 overflow-y-auto rounded-md border border-(--vscode-widget-border) bg-(--vscode-editorWidget-background) py-1 shadow-lg">
								{#if peopleLoading && !shownPeople.length}
									<li class="px-2 py-1 text-(--vscode-descriptionForeground)">{t('adeSources.drawer.loadingPeople')}</li>
								{:else if !shownPeople.length}
									<li class="px-2 py-1 text-(--vscode-descriptionForeground)">{t('adeSources.drawer.noPeople')}</li>
								{/if}
								{#each shownPeople as p (p.id)}
									<li role="option" aria-selected={p.current}>
										<button
											class="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-(--vscode-list-hoverBackground)"
											title={p.current ? t('adeSources.drawer.unassignPerson', { name: p.name }) : t('adeSources.drawer.assignPerson', { name: p.name })}
											onmousedown={(e) => e.preventDefault()}
											onclick={() => void choosePerson(p)}
										>
											<span class="w-3 shrink-0">{#if p.current}<Icon name="check" size={11} />{/if}</span>
											<span class="truncate">{p.name}</span>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					{#if calls.jiraPriority && jiraPriorities.length}
						<label class="flex items-center gap-1 text-(--vscode-descriptionForeground)">
							{t('adeSources.drawer.priority')}
							<select
								class="h-6 rounded-md border border-(--vscode-dropdown-border,var(--vscode-widget-border)) bg-(--vscode-dropdown-background) px-1 text-xs text-(--vscode-dropdown-foreground) disabled:opacity-50"
								value={jiraPriorities.find((p) => p.name === detail?.priorityName)?.id ?? ''}
								disabled={moving}
								onchange={(e) => void change(calls?.jiraPriority?.set(e.currentTarget.value))}
							>
								{#if !jiraPriorities.some((p) => p.name === detail?.priorityName)}<option value="" disabled>{detail.priorityName || '—'}</option>{/if}
								{#each jiraPriorities as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
							</select>
						</label>
					{/if}
					{#if calls.estimate}
						<label class="flex items-center gap-1 text-(--vscode-descriptionForeground)">
							{t('adeSources.drawer.estimate')}
							<input class="h-6 w-12 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-1 text-xs text-(--vscode-input-foreground)" inputmode="numeric" bind:value={estimateText} disabled={moving} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), saveEstimate())} onblur={saveEstimate} />
						</label>
					{/if}
					{#if calls.dueDate}
						<label class="flex items-center gap-1 text-(--vscode-descriptionForeground)">
							{t('adeSources.drawer.dueDate')}
							<input type="date" class="h-6 rounded-md border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-1 text-xs text-(--vscode-input-foreground)" value={detail.dueDate} disabled={moving} onchange={(e) => void change(calls?.dueDate?.(e.currentTarget.value || null))} />
						</label>
					{/if}
					{#if calls.priority && detail.priority !== null}
						<label class="flex items-center gap-1 text-(--vscode-descriptionForeground)">
							{t('adeSources.drawer.priority')}
							<select
								class="h-6 rounded-md border border-(--vscode-dropdown-border,var(--vscode-widget-border)) bg-(--vscode-dropdown-background) px-1 text-xs text-(--vscode-dropdown-foreground) disabled:opacity-50"
								value={detail.priority}
								disabled={moving}
								onchange={(e) => void change(calls?.priority?.(Number(e.currentTarget.value)))}
							>
								{#each PRIORITIES as label, p (p)}<option value={p}>{label}</option>{/each}
							</select>
						</label>
					{/if}
				</div>
			{/if}
			<p class="text-[11px] text-(--vscode-descriptionForeground)">{t('adeSources.drawer.editThere', { service })}</p>
			{#if detail.body}
				<section aria-label={t('adeSources.drawer.body')} class="rounded border border-(--vscode-widget-border) px-2 py-1.5 break-words whitespace-pre-wrap">{detail.body}{#if detail.truncated}…{/if}</section>
			{/if}
			<section aria-label={t('adeSources.drawer.comments')} class="space-y-2">
				<h3 class="font-medium text-(--vscode-descriptionForeground)">{t('adeSources.drawer.commentCount', { count: detail.comments.length + detail.omitted })}</h3>
				{#each detail.comments as c, i (i)}
					<article class="rounded border border-(--vscode-widget-border) px-2 py-1.5">
						<p class="mb-1 text-(--vscode-descriptionForeground)"><span class="font-medium text-(--vscode-foreground)">{c.author}</span> · {when(c.created_at)}</p>
						<p class="break-words whitespace-pre-wrap">{c.body}</p>
					</article>
				{/each}
			</section>
		{/if}
	</div>
	{#if detail}
		<form class="shrink-0 space-y-1.5 border-t border-(--vscode-widget-border) p-2" onsubmit={send}>
			<textarea class={[INPUT, 'h-16 resize-none']} placeholder={t('adeSources.drawer.commentPlaceholder')} aria-label={t('adeSources.drawer.comment')} bind:value={comment} disabled={busy} onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send(e)}></textarea>
			<div class="flex justify-end gap-1.5">
				<button type="button" class={BUTTON_SECONDARY} onclick={onclose}>{t('common.close')}</button>
				<button type="submit" class={BUTTON} disabled={busy || !comment.trim()}>{busy ? t('adeSources.drawer.sending') : t('adeSources.drawer.comment')}</button>
			</div>
		</form>
	{/if}
</aside>
