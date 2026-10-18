<script lang="ts">
	import type { Attachment } from './attachments.ts';
	// Agent panel (secondary side bar), laid out like VS Code's Chat view: a session switcher on
	// top, the selected task's timeline, and the composer pinned to the bottom. With no session
	// selected the composer starts a new task (title = the prompt's first line). Tasks go through
	// the ADE task store (worktree + tasks.json, then `agents.start`), so they also show up in the
	// Agents view and board; follow-ups resume the task's session.
	import AgentTimeline from './AgentTimeline.svelte';
	import Composer from './Composer.svelte';
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { runtime } from '#lib/ade/runtime.svelte.ts';
	import { appMode } from '#lib/workbench/mode.svelte.ts';
	import { STATUS_LABEL, type RunStatus } from './events';
	import { taskTitleFromPrompt } from './composerText';
	import { cliOf } from '#lib/ade/agentCli.ts';
	import { openAgents } from '#lib/ade/agentsMode.svelte.ts';

	let draft = $state('');
	let followUp = $state('');
	let followUpFiles = $state<Attachment[]>([]);
	let draftFiles = $state<Attachment[]>([]);
	let selected = $state<string | null>(null);
	let composingNew = $state(false);
	let busy = $state(false);

	const run = $derived(selected ? runtime.run(selected) : undefined);
	const rt = $derived(selected ? runtime.get(selected) : undefined);
	const meta = $derived(selected ? adeTasks.list.find((t) => t.slug === selected) : undefined);
	const model = $derived(settings.get<string>('kingu.agent.model') ?? '');

	// Default to the most recent run of this folder, else the newest task; drop a removed task.
	$effect(() => {
		if (selected !== null && !adeTasks.list.some((t) => t.slug === selected) && adeTasks.loaded) selected = null;
		if (selected === null && !composingNew) selected = runtime.all()[0]?.slug ?? adeTasks.list.at(-1)?.slug ?? null;
	});

	async function start(text: string, attachments: Attachment[]) {
		busy = true;
		try {
			// The chat-style panel runs the timeline; terminal (CLI) tasks live in the Agents layout.
			const created = await adeTasks.create({ title: taskTitleFromPrompt(text), prompt: text, base: '', mode: 'timeline', attachments });
			if (created) {
				selected = created;
				composingNew = false;
				draft = '';
				draftFiles = [];
			}
		} finally {
			busy = false;
		}
	}

	async function send(text: string, attachments: Attachment[]) {
		if (!selected || run?.status === 'starting') return;
		followUp = '';
		followUpFiles = [];
		await adeTasks.followUp(selected, text, attachments);
	}

	function newTask() {
		composingNew = true;
		selected = null;
	}

	const DOT: Record<RunStatus, string> = {
		starting: 'bg-(--vscode-descriptionForeground)',
		running: 'bg-(--vscode-editorInfo-foreground) animate-pulse',
		waiting: 'bg-(--vscode-editorWarning-foreground)',
		idle: 'bg-[#73C991]',
		stopped: 'bg-(--vscode-descriptionForeground)',
		failed: 'bg-(--vscode-errorForeground)',
		done: 'bg-(--vscode-descriptionForeground)'
	};
	const ICON_BTN = 'grid size-[22px] shrink-0 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	// Starters fill the prompt (they never start a task), like the Agents layout's empty composer.
	const STARTERS: { icon: IconName; label: string; text: string }[] = [
		{ icon: 'bug', label: 'แก้บั๊ก', text: 'แก้บั๊ก: ' },
		{ icon: 'check', label: 'เขียน test', text: 'เขียน test ให้ ' },
		{ icon: 'code', label: 'อธิบายโค้ด', text: 'อธิบายการทำงานของ ' }
	];
</script>

<div class="flex h-full flex-col text-[13px]">
	<!-- Session switcher + actions (VS Code chat view title actions). -->
	<div class="flex h-[30px] shrink-0 items-center gap-1 px-2">
		{#if adeTasks.list.length}
			<label class="min-w-0 flex-1">
				<span class="sr-only">Session</span>
				<select
					class="h-[22px] w-full truncate rounded-sm border border-transparent bg-transparent px-1 text-[13px] text-(--vscode-foreground) outline-none hover:border-(--vscode-widget-border) focus:border-(--vscode-focusBorder)"
					value={composingNew ? '' : (selected ?? '')}
					onchange={(e) => {
						const v = e.currentTarget.value;
						if (v) {
							composingNew = false;
							selected = v;
						} else newTask();
					}}
				>
					<option value="">＋ งานใหม่…</option>
					{#each adeTasks.views as v (v.meta.slug)}
						{@const r = runtime.run(v.meta.slug)}
						<option value={v.meta.slug}>{v.meta.title}{r ? ` — ${STATUS_LABEL[r.status]}` : ''}</option>
					{/each}
				</select>
			</label>
		{:else}
			<span class="flex-1 truncate text-(--vscode-descriptionForeground)">ยังไม่มีงาน</span>
		{/if}
		<button class={ICON_BTN} aria-label="งานใหม่" title="งานใหม่" onclick={newTask}><Icon name="plus" size={16} /></button>
		<button class={ICON_BTN} aria-label="Open in Agents (⇧⌘A)" title="Open in Agents (⇧⌘A)" onclick={() => appMode.setMode('agents')}>
			<Icon name="agentsLayout" size={16} />
		</button>
	</div>

	{#if selected && meta}
		<div class="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-xs text-(--vscode-descriptionForeground)">
			{#if run}<span class={['size-2 shrink-0 rounded-full', DOT[run.status]]} title={STATUS_LABEL[run.status]}></span>{/if}
			<button class="min-w-0 flex-1 truncate text-left font-mono hover:underline" title="เปิดหน้างาน" onclick={() => adeTasks.openTask(meta.slug)}
				>kingu/{meta.slug}</button
			>
			{#if rt?.working && run?.runId !== undefined}
				<button class="rounded-sm border border-(--vscode-widget-border) px-1.5 hover:bg-(--vscode-toolbar-hoverBackground)" title="หยุดรอบนี้" onclick={() => adeTasks.interrupt(meta.slug)}>หยุด</button>
			{/if}
			{#if rt?.live}
				<button class="hover:text-(--vscode-errorForeground)" title="จบ session" onclick={() => adeTasks.stop(meta.slug)}>จบงาน</button>
			{/if}
		</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-hidden border-t border-(--vscode-sideBar-border)">
		{#if selected && meta && cliOf(meta.agent)}
			<div class="grid h-full place-items-center p-6 text-center">
				<div class="max-w-64 space-y-2 text-(--vscode-descriptionForeground)">
					<div class="flex justify-center"><Icon name="terminal" size={28} /></div>
					<p class="text-(--vscode-foreground)">งานนี้รัน {cliOf(meta.agent)?.[0]} ใน terminal</p>
					<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => openAgents()}>เปิดใน Agents (⇧⌘A)</button>
				</div>
			</div>
		{:else if selected && meta}
			<AgentTimeline {run} onanswer={(p, decision, message) => selected && adeTasks.answer(selected, p.request_id, decision, message)} class="h-full p-3">
				{#snippet empty()}
					<p class="text-(--vscode-descriptionForeground)">
						ยังไม่มีบันทึกของรอบนี้{meta.session_id ? ' — พิมพ์ด้านล่างเพื่อทำงานต่อใน session เดิม' : ''}
					</p>
				{/snippet}
			</AgentTimeline>
		{:else}
			<div class="grid h-full place-items-center p-6 text-center">
				<div class="flex max-w-72 flex-col items-center gap-2 text-(--vscode-descriptionForeground)">
					<span class="text-(--vscode-foreground)"><Icon name="agent" size={40} /></span>
					<p class="text-sm font-semibold text-(--vscode-foreground)">สั่งงานให้ Arkai</p>
					<p class="text-xs leading-5">แต่ละงานได้ git worktree ของตัวเอง Arkai จะขออนุญาตก่อนรันคำสั่งหรือแก้ไฟล์</p>
					<div class="mt-2 flex flex-wrap justify-center gap-1.5">
						{#each STARTERS as s (s.label)}
							<button
								class="flex h-7 items-center gap-1.5 rounded-full border border-(--vscode-widget-border) px-3 text-xs hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
								onclick={() => (draft = draft.trim() ? `${s.text}${draft}` : s.text)}
							>
								<Icon name={s.icon} size={13} />{s.label}
							</button>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</div>

	<div class="shrink-0 p-2">
		{#if selected && meta && cliOf(meta.agent)}
			<!-- The CLI takes input in its own terminal. -->
		{:else if selected && meta}
			<Composer
				bind:value={followUp}
				attach
				bind:attachments={followUpFiles}
				placeholder={rt?.live ? 'ส่งข้อความเพิ่มเติม…' : (run?.sessionId ?? meta.session_id) ? 'ทำงานต่อใน session เดิม…' : 'พิมพ์เพื่อเริ่มใหม่…'}
				disabled={run?.status === 'starting'}
				onsubmit={send}
			>
				{#snippet chips()}<span class="truncate">{run?.model ?? meta.model ?? model}</span>{/snippet}
			</Composer>
		{:else}
			<Composer bind:value={draft} attach bind:attachments={draftFiles} placeholder="อยากให้ Arkai ทำอะไร เช่น แก้บั๊กหน้า login…" {busy} autofocus={composingNew} onsubmit={start}>
				{#snippet chips()}<span class="truncate">{model}</span><span aria-hidden="true">·</span><span>worktree ใหม่</span>{/snippet}
			</Composer>
		{/if}
	</div>
</div>
