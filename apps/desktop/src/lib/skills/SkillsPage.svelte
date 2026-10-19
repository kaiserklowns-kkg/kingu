<script lang="ts">
	// Settings › Skills: every skill agents can get, by source (Kingu-managed, Snaps, built-in, this
	// folder's and your own .claude/skills), an on/off switch where Kingu decides, "Install from
	// Link…" / "Install from File…" with a review of the staged files and SKILL.md before anything
	// is installed, Update / Remove / Copy Share Link / Export, and the skills the team shared. The
	// store (skills.svelte.ts) does the work.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t, type MessageKey } from '#lib/i18n/index.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { skills } from './skills.svelte.ts';
	import { canUnshare, flagText, formatSize, groupBySource, isLive, isRisky, isTeamShareable, originLabel, reviewFlags, SOURCE_LABEL, teamSkillState, totalSize, type SkillInfo, type TeamSkillState } from './skillModel.ts';

	const groups = $derived(groupBySource(skills.list));
	const review = $derived(skills.review);
	const candidate = $derived(review?.prepared.candidates.find((c) => c.rel === review.rel));
	const replaces = $derived(!!candidate && !!review?.prepared.existing.includes(candidate.name));
	const signedIn = $derived(!!team.serverUrl && !!team.status?.signed_in);

	const SECTION = 'mt-7 mb-2 text-xs font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
	const CARD = 'rounded-xl border border-(--vscode-widget-border)';
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BUTTON = 'flex h-8 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-3 text-[13px] hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
	const PRIMARY = `${BUTTON} border-transparent bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)`;
	const ICON = 'grid size-7 place-items-center rounded-md hover:bg-(--vscode-toolbar-hoverBackground)';
	const SMALL = 'h-6 rounded-md border border-(--vscode-widget-border) px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground)';

	const TEAM_STATE = { match: 'skills.team.state.match', different: 'skills.team.state.different', missing: 'skills.team.state.missing' } as const satisfies Record<TeamSkillState, MessageKey>;
	const sourceNote = (s: SkillInfo) => (s.source === 'snap' && s.snap ? `${t(SOURCE_LABEL.snap)} · ${s.snap}` : t(SOURCE_LABEL[s.source]));
	const riskyCount = (s: SkillInfo) => s.flags.filter(isRisky).length;
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-[880px] px-8 py-6">
		<div class="flex items-center gap-2">
			<h1 class="flex flex-1 items-center gap-2 text-lg font-semibold"><Icon name="sparkle" size={20} />{t('skills.title')}</h1>
			<button class={BUTTON} disabled={skills.loading} onclick={() => skills.load()} aria-label={t('skills.refresh')} title={t('skills.refresh')}>
				<span class={['grid place-items-center', skills.loading && 'animate-spin']}><Icon name="refresh" size={14} /></span>
			</button>
			<button class={BUTTON} disabled={!!skills.busy} onclick={() => skills.installFromFile()}><Icon name="file" size={14} />{t('skills.installFromFile')}</button>
			<button class={PRIMARY} disabled={!!skills.busy} onclick={() => skills.installFromLink()}><Icon name="plus" size={14} />{t('skills.installFromLink')}</button>
		</div>
		<p class="mt-1 text-[13px] {MUTED}">{t('skills.intro')}</p>
		{#if skills.error}<p class="mt-3 text-[13px] text-(--vscode-errorForeground)">{skills.error}</p>{/if}
		{#if skills.busy}<p class="mt-3 flex items-center gap-2 text-[13px] {MUTED}"><span class="grid animate-spin place-items-center"><Icon name="refresh" size={13} /></span>{skills.busy}</p>{/if}

		{#if review && candidate}
			<h2 class={SECTION}>{t(review.mode === 'update' ? 'skills.review.updateTitle' : 'skills.review.title')}</h2>
			<div class="{CARD} space-y-3 px-4 py-3" role="region" aria-label={t('skills.review.title')}>
				<div class="text-xs {MUTED}">{t('skills.review.from', { origin: originLabel(review.prepared.origin) })}</div>
				{#if review.prepared.candidates.length > 1}
					<div>
						<div class="mb-1 text-xs {MUTED}">{t('skills.review.pick', { count: review.prepared.candidates.length })}</div>
						<div class="flex flex-wrap gap-1.5">
							{#each review.prepared.candidates as c (c.rel)}
								<button
									class={['rounded-md border px-2 py-0.5 text-xs', c.rel === review.rel ? 'border-(--vscode-focusBorder) bg-(--vscode-list-inactiveSelectionBackground)' : 'border-(--vscode-widget-border) hover:bg-(--vscode-list-hoverBackground)', c.error && 'text-(--vscode-errorForeground)']}
									aria-pressed={c.rel === review.rel}
									title={c.rel}
									onclick={() => skills.review && (skills.review.rel = c.rel)}>{c.name}</button
								>
							{/each}
						</div>
					</div>
				{/if}
				<div>
					<div class="flex flex-wrap items-center gap-2 text-[13px]">
						<span class="font-medium">{candidate.name}</span>
						{#if candidate.rel}<span class="font-mono text-xs {MUTED}">{candidate.rel}</span>{/if}
						{#if replaces}<span class="rounded bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)">{t('skills.review.replaces')}</span>{/if}
					</div>
					{#if candidate.description}<p class="mt-0.5 text-[13px]">{candidate.description}</p>{/if}
					{#if candidate.error}<p class="mt-1 text-xs text-(--vscode-errorForeground)">{candidate.error}</p>{/if}
				</div>
				{#if !candidate.error}
					{@const flags = reviewFlags(candidate.flags)}
					{#if flags.length}
						<ul class="space-y-0.5 text-xs" aria-label={t('skills.review.flags')}>
							{#each flags as f, i (i)}
								<li class={['flex items-start gap-1.5', isRisky(f) ? 'text-(--vscode-editorWarning-foreground)' : MUTED]}><Icon name={isRisky(f) ? 'warning' : 'info'} size={12} />{flagText(f)}</li>
							{/each}
						</ul>
					{:else}
						<p class="text-xs {MUTED}">{t('skills.review.noFlags')}</p>
					{/if}
					<details>
						<summary class="cursor-pointer text-xs {MUTED}">{t('skills.review.files', { count: candidate.files.length, size: formatSize(totalSize(candidate.files)) })}</summary>
						<ul class="mt-1 max-h-40 overflow-y-auto font-mono text-[11px]">
							{#each candidate.files as f (f.path)}
								<li class="flex gap-2"><span class="flex-1 truncate">{f.path}{f.executable ? ' *' : ''}</span><span class={MUTED}>{formatSize(f.size)}</span></li>
							{/each}
						</ul>
					</details>
				{/if}
				<div>
					<div class="mb-1 text-xs {MUTED}">SKILL.md{candidate.truncated ? ` · ${t('skills.review.truncated')}` : ''}</div>
					<pre class="max-h-72 overflow-auto rounded-md border border-(--vscode-widget-border) bg-(--vscode-textCodeBlock-background) p-2 font-mono text-[11px] whitespace-pre-wrap">{candidate.skillMd}</pre>
				</div>
				<div class="flex justify-end gap-2">
					<button class={BUTTON} onclick={() => skills.cancelReview()}>{t('common.cancel')}</button>
					<button class={PRIMARY} disabled={!!candidate.error} onclick={() => skills.commitReview()}>{t(replaces ? 'skills.review.update' : 'skills.review.install')}</button>
				</div>
			</div>
		{/if}

		{#each groups as g (g.source)}
			<h2 class={SECTION}>{t(SOURCE_LABEL[g.source])}</h2>
			<div class="{CARD} divide-y divide-(--vscode-widget-border)">
				{#each g.items as s (s.id)}
					<div class="px-4 py-3">
						<div class="flex items-center gap-3">
							<span class={['size-2 shrink-0 rounded-full', s.error ? 'bg-red-500' : isLive(s) ? 'bg-green-500' : 'bg-(--vscode-descriptionForeground)/40']}></span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
									<span class="font-medium">{s.name}</span>
									<span class="rounded bg-(--vscode-badge-background) px-1.5 text-[11px] text-(--vscode-badge-foreground)">{sourceNote(s)}</span>
									{#if s.inactive}<span class="text-xs {MUTED}">· {t(s.source === 'builtin' ? 'skills.inactiveBuiltin' : 'skills.inactiveSnap')}</span>{/if}
									{#if riskyCount(s)}<span class="text-xs text-(--vscode-editorWarning-foreground)" title={s.flags.filter(isRisky).map(flagText).join('\n')}>· {t('skills.risky', { count: riskyCount(s) })}</span>{/if}
								</div>
								{#if s.description}<div class="mt-0.5 line-clamp-2 text-xs {MUTED}" title={s.description}>{s.description}</div>{/if}
								{#if s.origin}<div class="mt-0.5 truncate font-mono text-[11px] {MUTED}" title={originLabel(s.origin)}>{originLabel(s.origin)}</div>{/if}
								{#if s.error}<div class="mt-0.5 text-xs text-(--vscode-errorForeground)">{s.error}</div>{/if}
							</div>
							<button class={ICON} aria-label={t('skills.preview')} title={t('skills.preview')} aria-expanded={skills.previewId === s.id} onclick={() => skills.togglePreview(s)}><Icon name="fileText" size={14} /></button>
							{#if s.dir}<button class={ICON} aria-label={t('skills.reveal')} title={s.dir} onclick={() => skills.reveal(s)}><Icon name="goToFile" size={14} /></button>{/if}
							{#if s.source === 'managed'}
								{#if s.origin}<button class={ICON} aria-label={t('skills.update')} title={t('skills.update')} disabled={!!skills.busy} onclick={() => skills.update(s)}><Icon name="refresh" size={14} /></button>{/if}
								<button class={ICON} aria-label={t('skills.copyLink')} title={s.shareLink ?? t('skills.copyLinkLocal')} onclick={() => skills.copyShareLink(s)}><Icon name="copy" size={14} /></button>
								{#if signedIn && isTeamShareable(s)}<button class={ICON} aria-label={t('skills.team.share')} title={t('skills.team.share')} onclick={() => skills.shareWithTeam(s)}><Icon name="publish" size={14} /></button>{/if}
							{/if}
							{#if s.dir && !s.error}<button class={ICON} aria-label={t('skills.export')} title={t('skills.export')} onclick={() => skills.exportSkill(s)}><Icon name="newFile" size={14} /></button>{/if}
							{#if s.source === 'managed'}<button class={ICON} aria-label={t('skills.remove')} title={t('skills.remove')} onclick={() => skills.remove(s)}><Icon name="trash" size={14} /></button>{/if}
							{#if s.toggleable}
								<button
									role="switch"
									aria-checked={s.enabled}
									aria-label={t('skills.toggle', { name: s.name })}
									class={['relative h-5 w-9 shrink-0 rounded-full transition-colors', s.enabled ? 'bg-(--vscode-button-background)' : 'bg-(--vscode-widget-border)']}
									onclick={() => skills.setEnabled(s, !s.enabled)}
								>
									<span class={['absolute top-0.5 size-4 rounded-full bg-(--vscode-button-foreground) shadow transition-[left]', s.enabled ? 'left-[18px]' : 'left-0.5']}></span>
								</button>
							{:else}
								<span class="w-9 shrink-0 text-center text-[11px] {MUTED}" title={t('skills.readOnly')}>{t('skills.readOnlyShort')}</span>
							{/if}
						</div>
						{#if skills.previewId === s.id}
							<pre class="mt-2 max-h-72 overflow-auto rounded-md border border-(--vscode-widget-border) bg-(--vscode-textCodeBlock-background) p-2 font-mono text-[11px] whitespace-pre-wrap">{skills.previewText}</pre>
						{/if}
					</div>
				{/each}
			</div>
		{/each}
		{#if !groups.length && !skills.loading}
			<div class="{CARD} mt-6 px-4 py-6 text-center text-[13px] {MUTED}">{t('skills.empty')}</div>
		{/if}

		{#if signedIn}
			<h2 class={SECTION}>{t('skills.team.title')}</h2>
			{#if skills.teamError}<p class="mb-2 text-xs text-(--vscode-errorForeground)">{skills.teamError}</p>{/if}
			{#if skills.team?.items.length}
				<div class="{CARD} divide-y divide-(--vscode-widget-border)">
					{#each skills.team.items as entry (entry.skill_name)}
						{@const state = teamSkillState(entry, skills.list)}
						<div class="flex items-center gap-3 px-4 py-3">
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-x-2 text-[13px]">
									<span class="font-medium">{entry.skill_name}</span>
									<span class="text-xs {MUTED}">· {t(TEAM_STATE[state])}</span>
									<span class="text-xs {MUTED}">· {t('skills.team.sharedBy', { user: entry.shared_by })}</span>
								</div>
								<div class="mt-0.5 line-clamp-2 text-xs {MUTED}">{entry.description}</div>
								{#if entry.note}<div class="mt-0.5 text-xs">{entry.note}</div>{/if}
							</div>
							{#if state !== 'match'}
								<button class={SMALL} disabled={!!skills.busy} onclick={() => skills.installTeam(entry)}>{t(state === 'missing' ? 'skills.team.install' : 'skills.team.reinstall')}</button>
							{/if}
							{#if canUnshare(entry, skills.team.user_id, skills.team.role)}
								<button class="{ICON} {MUTED}" aria-label={t('skills.team.unshare')} title={t('skills.team.unshare')} onclick={() => skills.unshare(entry)}><Icon name="close" size={14} /></button>
							{/if}
						</div>
					{/each}
				</div>
			{:else if !skills.teamError}
				<div class="{CARD} px-4 py-4 text-center text-[13px] {MUTED}">{t('skills.team.empty')}</div>
			{/if}
		{/if}
		<p class="mt-3 text-xs {MUTED}">{t('skills.footnote')}</p>
	</div>
</div>
