<script lang="ts">
	// Task page (`task://<slug>`): header, the agent timeline (live from the agents store, with
	// permission cards to answer), follow-ups that resume the task's session, and the review section — files
	// changed in the worktree since it forked from its base, accept/reject per file, diffs, then
	// commit, PR (gh) or a local merge into the base.
	import { untrack } from 'svelte';
	import AgentTimeline from '#lib/agent/AgentTimeline.svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { splitPath, taskDiffKey } from '#lib/workbench/scm.ts';
	import { keyLabel } from '#lib/workbench/keys.ts';
	import { aggregateStats, formatSummaryUsage, reviewChip, STATUS_LABEL, timeAgo, type FileChange } from './model';
	import { runtime } from './runtime.svelte';
	import { adeTasks } from './tasks.svelte';
	import PrChecks from './PrChecks.svelte';
	import { forgeOf, ft } from './forge.ts';
	import { t as tr } from '#lib/i18n/index.ts';
	import CacheTimer from './CacheTimer.svelte';
	import CliQuestion from './CliQuestion.svelte';
	import DiffNotesList from './DiffNotesList.svelte';
	import { issues } from './issues.svelte.ts';
	import { issueRef } from './issues.ts';
	import { sourceName } from './taskSources.ts';
	import { cliOf } from './agentCli';
	import { adeLayout } from './adeLayout.svelte';
	import { hunkReview } from './hunkReview.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { changesKey } from '#lib/workbench/viewers.ts';
	import { BUTTON, BUTTON_SECONDARY, ICON_BUTTON, INPUT, LETTER_COLOR, STATUS_DOT, TONE } from './ui';

	/** `timeline` / `review`: one half, for the Agents layout's main area and changes panel. */
	/** `embedded`: inside the ADE right side bar's Source Control, which has its own commit box and Checks tab. */
	let { slug, sections = 'all', embedded = false }: { slug: string; sections?: 'all' | 'timeline' | 'review'; embedded?: boolean } = $props();

	const view = $derived(adeTasks.find(slug));
	/** The task runs its agent CLI in a terminal (Orca way), not the timeline. */
	const cli = $derived(view ? cliOf(view.meta.agent) : null);
	const meta = $derived(view?.meta);
	const stat = $derived(view?.stat);
	const totals = $derived(stat ? aggregateStats(stat.files) : null);
	const run = $derived(runtime.run(slug));
	const rt = $derived(view?.runtime);
	/** A turn is in progress (or waiting for a permission answer): review actions wait. */
	const running = $derived(!!rt?.working);
	const resumable = $derived(!!(run?.sessionId ?? meta?.session_id));
	const busy = $derived(adeTasks.busy[slug]);
	const accepted = $derived(new Set(meta?.accepted ?? []));
	const mac = keyLabel('cmd+a').startsWith('⌘');

	let commitMsg = $state('');
	let followUp = $state('');
	let msgFor = '';

	// Prefill the commit message from the task title (once per task).
	$effect(() => {
		if (meta && msgFor !== slug) {
			msgFor = slug;
			commitMsg = adeTasks.defaultCommitMessage(slug);
		}
	});

	// Re-read the worktree's changes when the page opens (only `slug` is a dependency).
	$effect(() => {
		const s = slug;
		untrack(() => {
			void adeTasks.refreshStat(s);
			if (!adeTasks.gh) void adeTasks.checkGh();
		});
	});

	const statusText = (f: FileChange) =>
		({ M: 'แก้ไข', A: 'เพิ่ม', D: 'ลบ', R: 'เปลี่ยนชื่อ', C: 'คัดลอก', T: 'เปลี่ยนชนิด', '?': 'ไฟล์ใหม่ (untracked)' })[f.status] ?? f.status;
	const letter = (f: FileChange) => (f.status === '?' ? 'U' : f.status);
	/** In the Agents layout the diff opens as a tab of the task's worktree; in the IDE as an editor tab. */
	function openDiff(rel: string) {
		if (appMode.isAgents) adeLayout.openFile(slug, taskDiffKey(slug, rel));
		else void adeTasks.openDiff(slug, rel);
	}

	function reject(f: FileChange) {
		const paths = f.orig_path ? [f.path, f.orig_path] : [f.path];
		return adeTasks.reject(slug, paths, splitPath(f.path)[0]);
	}

	/** Unaccepted files go back to the base; files with accepted hunks keep those (hunkReview). */
	const rejectUnaccepted = () => hunkReview.rejectUnaccepted(slug);

	async function sendFollowUp(e: Event) {
		e.preventDefault();
		const p = followUp.trim();
		if (!p || run?.status === 'starting') return;
		followUp = '';
		await adeTasks.followUp(slug, p);
	}

	function onCommitKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey)) {
			e.preventDefault();
			void adeTasks.commit(slug, commitMsg);
		}
	}
</script>

{#if !meta || !view}
	<div class="grid h-full place-items-center text-sm text-(--vscode-descriptionForeground)">
		{adeTasks.loaded ? `ไม่พบงาน ${slug}` : 'กำลังโหลด…'}
	</div>
{:else}
	{@const chip = reviewChip(view)}
	<div class="flex h-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)">
		{#if sections !== 'review'}
		<header class="shrink-0 border-b border-(--vscode-widget-border) px-4 py-3">
			<div class="flex items-center gap-2">
				<span class={['size-2.5 shrink-0 rounded-full', STATUS_DOT[view.status]]}></span>
				<h1 class="min-w-0 flex-1 truncate text-base font-semibold" title={meta.title}>{meta.title}</h1>
				<CacheTimer {view} />
				<span class="rounded-full border border-(--vscode-widget-border) px-2 text-xs">{STATUS_LABEL[view.status]}</span>
				<span class={['rounded-full border px-2 text-xs', TONE[chip.tone]]}>{chip.label}</span>
			</div>
			<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--vscode-descriptionForeground)">
				<span class="flex items-center gap-1 font-mono"><Icon name="branch" size={12} />kingu/{meta.slug} ← {meta.base}</span>
				<span>{meta.agent}{(view.runtime?.model ?? meta.model) ? ` · ${view.runtime?.model ?? meta.model}` : ''}</span>
				<span>สร้าง {timeAgo(meta.created_at, adeTasks.now)}</span>
				{#if meta.pr_url}<a class="text-(--vscode-textLink-foreground) hover:underline" href={meta.pr_url} target="_blank" rel="noreferrer">{meta.pr_url}</a>{/if}
				{#if meta.issue}
					{@const issue = meta.issue}
					<button class="text-(--vscode-textLink-foreground) hover:underline" title="เปิด issue บน {sourceName(issue)}: {issue.url}" onclick={() => issues.open(issue)}>issue {issueRef(issue)}</button>
				{/if}
				<span class="flex-1"></span>
				{#if running && run?.runId !== undefined}
					<button class={BUTTON_SECONDARY} title="หยุดรอบนี้ session ยังเปิดอยู่ (Interrupt)" onclick={() => adeTasks.interrupt(slug)}><Icon name="stop" size={12} /> หยุดรอบนี้</button>
				{/if}
				{#if rt?.live}
					<button class={BUTTON_SECONDARY} title="จบ session (ส่งข้อความต่อได้ภายหลัง จะ resume session เดิม)" onclick={() => adeTasks.stop(slug)}>จบ session</button>
				{/if}
				<button class={BUTTON_SECONDARY} onclick={() => adeTasks.quickOpen(slug)} disabled={!!view.statError}><Icon name="goToFile" size={12} /> เปิดไฟล์ใน worktree</button>
				{#if view.status === 'done'}
					<button class={BUTTON_SECONDARY} onclick={() => adeTasks.markDone(slug, false)}>เปิดงานอีกครั้ง</button>
				{:else}
					<button class={BUTTON_SECONDARY} onclick={() => adeTasks.markDone(slug)} disabled={running}><Icon name="check" size={12} /> ปิดงาน</button>
				{/if}
				<button class={BUTTON_SECONDARY} onclick={() => adeTasks.remove(slug)} disabled={running}><Icon name="trash" size={12} /> ลบ</button>
			</div>
			{#if rt?.usage || meta.last_run}
				<div class="mt-1 text-xs text-(--vscode-descriptionForeground)">
					{#if rt?.usage}
						session: {rt.usage}
					{:else if meta.last_run}
						รอบล่าสุด ({timeAgo(meta.last_run.at, adeTasks.now)}): {meta.last_run.summary ?? meta.last_run.status}{formatSummaryUsage(meta.last_run) ? ` · ${formatSummaryUsage(meta.last_run)}` : ''}
					{/if}
				</div>
			{/if}
			{#if view.status === 'waiting'}
				<p class="mt-2 rounded border border-(--vscode-editorWarning-foreground) px-2 py-1 text-xs text-(--vscode-editorWarning-foreground)">
					agent รออนุญาต {rt?.pendingPermissions} รายการ (ตอบได้ใน timeline): {rt?.lastEvent}
				</p>
			{/if}
		</header>
		{/if}

		<div class={['grid min-h-0 flex-1 grid-cols-1 overflow-hidden', sections === 'all' && 'lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]']}>
			{#if sections !== 'review'}
			<!-- Timeline -->
			<section aria-label="Timeline" class={['flex min-h-0 flex-col', sections === 'all' && 'border-r border-(--vscode-widget-border)']}>
				<h2 class="shrink-0 px-4 pt-2 text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase">Timeline</h2>
				{#if meta.prompt}
					<p class="mx-4 mt-1 line-clamp-3 shrink-0 rounded bg-(--vscode-input-background) px-2 py-1 text-xs whitespace-pre-wrap" title={meta.prompt}>{meta.prompt}</p>
				{/if}
				{#if cli}
					<!-- The agent CLI runs in a terminal of the worktree (Agents); a timeline follow-up here would start a second agent. -->
					<div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-(--vscode-descriptionForeground)">
						<Icon name="terminal" size={24} />
						<p>งานนี้รัน <span class="font-mono">{cli.join(' ')}</span> ใน terminal ของ worktree</p>
						<button class={BUTTON_SECONDARY} onclick={() => (appMode.setMode('agents'), adeLayout.show(slug))}>เปิดใน Agents (⇧⌘A)</button>
						<CliQuestion {slug} class="w-full max-w-md text-left" />
					</div>
				{:else}
					<AgentTimeline {run} onanswer={(p, decision, message, answers) => adeTasks.answer(slug, p.request_id, decision, message, answers)} class="flex-1 px-4 py-2">
						{#snippet empty()}
							<p class="text-(--vscode-descriptionForeground)">
								{run && !run.ended
									? 'กำลังเริ่ม…'
									: `ยังไม่มีบันทึกของรอบนี้ (timeline เก็บในหน่วยความจำ จะหายเมื่อปิดแอป)${resumable ? ' — ส่งข้อความด้านล่างเพื่อทำงานต่อใน session เดิม' : ''}`}
							</p>
						{/snippet}
					</AgentTimeline>
					<form class="flex shrink-0 gap-1.5 border-t border-(--vscode-widget-border) p-2" onsubmit={sendFollowUp}>
						<input
							class={INPUT}
							placeholder={rt?.live ? 'ส่งข้อความเพิ่มเติมถึง agent' : resumable ? 'สั่งงานต่อ (resume session เดิม)' : 'สั่งงานเพิ่มใน worktree นี้ (เริ่ม session ใหม่)'}
							aria-label="คำสั่งเพิ่มเติม"
							bind:value={followUp}
							disabled={run?.status === 'starting'}
						/>
						<button class={BUTTON} disabled={run?.status === 'starting' || !followUp.trim()}><Icon name="play" size={12} /> ส่ง</button>
					</form>
				{/if}
			</section>
			{/if}

			{#if sections !== 'timeline'}
			<!-- Review -->
			<section aria-label="Review" class="flex min-h-0 flex-col overflow-y-auto text-xs">
				<div class="flex shrink-0 items-center gap-2 px-3 pt-2">
					<h2 class="text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase">{embedded ? 'เทียบกับ base (Committed on Branch)' : 'Review'}</h2>
					{#if totals}
						<span class="font-mono"><span class="text-[#73C991]">+{totals.added}</span> <span class="text-[#F48771]">−{totals.deleted}</span></span>
						<span class="text-(--vscode-descriptionForeground)">{totals.files} ไฟล์{totals.binary ? ` (binary ${totals.binary})` : ''}</span>
					{/if}
					<span class="flex-1"></span>
					<button class={ICON_BUTTON} aria-label="ดูการเปลี่ยนแปลงทั้งหมดในหน้าเดียว" title="ดูการเปลี่ยนแปลงทั้งหมดในหน้าเดียว" onclick={() => (appMode.setMode('workbench'), editors.open(changesKey(slug), { preview: false }))}><Icon name="files" size={14} /></button>
					<button class={ICON_BUTTON} aria-label="รีเฟรช" title="รีเฟรช" onclick={() => adeTasks.refreshStat(slug)}><Icon name="refresh" size={14} /></button>
				</div>
				{#if view.statError}
					<p class="px-3 py-2 text-(--vscode-errorForeground)">{view.statError}</p>
				{:else if stat}
					<p class="px-3 pt-0.5 text-(--vscode-descriptionForeground)">
						เทียบกับ {stat.base} ณ จุดที่แตก ({stat.merge_base.slice(0, 8)}) · {stat.ahead} commit ใหม่{stat.behind ? ` · ${stat.base} ไปข้างหน้า ${stat.behind} commit` : ''}
					</p>
					<ul class="mt-1 px-1" aria-label="ไฟล์ที่เปลี่ยน">
						{#each stat.files as f (f.path)}
							{@const [name, dir] = splitPath(f.path)}
							{@const ok = accepted.has(f.path)}
							<li class="group flex h-(--kg-row-height) items-center gap-1.5 rounded-sm px-2 hover:bg-(--vscode-list-hoverBackground)">
								<button
									class={['grid size-4 shrink-0 place-items-center rounded-sm border', ok ? 'border-[#73C991] bg-[#73C991]/20 text-[#73C991]' : 'border-(--vscode-widget-border) text-transparent']}
									role="checkbox"
									aria-checked={ok}
									aria-label="ยอมรับ {f.path}"
									title={ok ? 'ยอมรับแล้ว (คลิกเพื่อยกเลิก)' : 'ยอมรับไฟล์นี้'}
									onclick={() => adeTasks.toggleAccept(slug, f.path)}><Icon name="check" size={12} /></button
								>
								<button class="flex min-w-0 flex-1 items-baseline gap-1.5 text-left" title="{statusText(f)}: {f.orig_path ? `${f.orig_path} → ` : ''}{f.path} (เปิด diff)" onclick={() => openDiff(f.path)}>
									<span class={['truncate', f.status === 'D' && 'line-through', ok && 'opacity-60']}>{name}</span>
									<span class="truncate text-[11px] text-(--vscode-descriptionForeground)">{f.orig_path ? `← ${f.orig_path}` : dir}</span>
								</button>
								<span class="shrink-0 font-mono text-[11px]">
									{#if f.added === null}<span class="text-(--vscode-descriptionForeground)">bin</span>{:else}<span class="text-[#73C991]">+{f.added}</span> <span class="text-[#F48771]">−{f.deleted}</span>{/if}
								</span>
								<button class={[ICON_BUTTON, 'invisible group-focus-within:visible group-hover:visible']} aria-label="ปฏิเสธ {f.path}" title="ปฏิเสธ: คืนไฟล์เป็นแบบใน {meta.base}" onclick={() => reject(f)}>
									<Icon name="discard" size={14} />
								</button>
								<span class={['w-3 shrink-0 text-center font-mono', LETTER_COLOR[f.status] ?? '']} title={statusText(f)}>{letter(f)}</span>
							</li>
						{:else}
							<li class="px-2 py-1 text-(--vscode-descriptionForeground)">ไม่มีไฟล์ที่เปลี่ยนจาก {meta.base}</li>
						{/each}
					</ul>
					<DiffNotesList worktree={slug} />
					{#if stat.files.length}
						<div class="flex gap-1.5 px-3 pt-1">
							<button class={BUTTON_SECONDARY} disabled={!!busy || running || accepted.size === stat.files.length} onclick={rejectUnaccepted}>
								<Icon name="discard" size={12} /> ปฏิเสธไฟล์ที่ไม่ได้ติ๊ก
							</button>
						</div>
					{/if}

					{#if !embedded}
					<div class="mt-3 space-y-1.5 border-t border-(--vscode-widget-border) px-3 pt-3">
						<label class="block text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase" for="commit-{slug}">Commit</label>
						<textarea id="commit-{slug}" class={[INPUT, 'h-16 resize-y font-mono']} bind:value={commitMsg} onkeydown={onCommitKey} aria-label="ข้อความ commit"></textarea>
						<button class={BUTTON} disabled={!!busy || running || !stat.dirty} title="stage ทุกไฟล์ใน worktree แล้ว commit ({mac ? '⌘' : 'Ctrl+'}Enter)" onclick={() => adeTasks.commit(slug, commitMsg)}>
							<Icon name="check" size={12} /> Commit {stat.dirty ? '' : '(ไม่มีอะไรให้ commit)'}
						</button>
					</div>
					{/if}

					<div class="mt-3 space-y-1.5 border-t border-(--vscode-widget-border) px-3 py-3">
						<div class="text-[11px] font-bold text-(--vscode-descriptionForeground) uppercase">ส่งงาน</div>
						<div class="flex flex-wrap gap-1.5">
							<button class={BUTTON} disabled={!!busy || running || stat.ahead === 0 || !!meta.pr_url} onclick={() => adeTasks.createPr(slug)}>
								<Icon name="pullRequest" size={12} /> {ft('forge.create.button', forgeOf(adeTasks.gh))}
							</button>
							<button class={BUTTON_SECONDARY} disabled={!!busy || running || stat.ahead === 0 || stat.dirty} onclick={() => adeTasks.merge(slug, 'ff')} title="fast-forward {meta.base} ไปที่ kingu/{slug}">
								<Icon name="merge" size={12} /> Merge เข้า {meta.base} (ff)
							</button>
							<button class={BUTTON_SECONDARY} disabled={!!busy || running || stat.ahead === 0 || stat.dirty} onclick={() => adeTasks.merge(slug, 'merge')} title="สร้าง merge commit บน {meta.base}">
								Merge commit
							</button>
						</div>
						{#if adeTasks.gh?.provider === 'gitlab' && !adeTasks.gh.authenticated}
							<p class="text-(--vscode-descriptionForeground)">{adeTasks.gh.detail}</p>
						{:else if adeTasks.gh && !adeTasks.gh.installed}
							<p class="text-(--vscode-descriptionForeground)">{tr('forge.status.ghMissingCreate')}</p>
						{:else if adeTasks.gh && !adeTasks.gh.authenticated}
							<p class="text-(--vscode-descriptionForeground)">{tr('forge.status.ghSignedOut')}</p>
						{/if}
						{#if stat.ahead === 0}<p class="text-(--vscode-descriptionForeground)">{ft('forge.create.commitFirst', forgeOf(adeTasks.gh))}</p>{/if}
						{#if busy}<p class="text-(--vscode-editorInfo-foreground)">{busy}…</p>{/if}
					</div>

					<!-- In the Agents layout the PR lives in the Checks tab (AdeChecks); the full task page keeps it here. -->
					{#if adeTasks.gh?.authenticated && !embedded && sections === 'all'}
						<div class="border-t border-(--vscode-widget-border) px-3 py-3"><PrChecks {slug} /></div>
					{/if}
				{:else}
					<p class="px-3 py-2 text-(--vscode-descriptionForeground)">กำลังอ่านการเปลี่ยนแปลง…</p>
				{/if}
			</section>
			{/if}
		</div>
	</div>
{/if}
