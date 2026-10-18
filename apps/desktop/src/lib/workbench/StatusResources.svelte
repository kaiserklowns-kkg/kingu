<script lang="ts">
	// The right end of the status bar, modelled on Orca's footer: keep-awake (On / Auto / Off),
	// the Resource Manager (memory, CPU, terminals and processes under Kingu) and listening ports.
	// Each item opens a popup above it; right-clicking the status bar hides or shows them.
	import Icon from './Icon.svelte';
	import StatusPopover from './StatusPopover.svelte';
	import { system, type ProcessRow } from './system.svelte';
	import { formatBytes, KEEP_AWAKE_MODES, sparkline, terminalGroup, type KeepAwakeMode } from './system';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { workspace } from './workspace.svelte';
	import { status } from './status.svelte';

	type Open = 'awake' | 'resources' | 'ports' | null;
	let open = $state<Open>(null);
	let anchor = $state<HTMLElement | null>(null);
	/** A terminal or process waiting for the "Kill" confirmation. */
	/** The row asking to confirm a stop: a terminal's session key, or `pid:<n>` for a process. */
	let confirming = $state<string | null>(null);

	const showAwake = $derived(settings.get<boolean>('kingu.statusBar.keepAwake.visible') !== false);
	const showResources = $derived(settings.get<boolean>('kingu.statusBar.resources.visible') !== false);
	const showPorts = $derived(settings.get<boolean>('kingu.statusBar.ports.visible') !== false);
	const mode = $derived((settings.get<string>('kingu.keepAwake') ?? 'off') as KeepAwakeMode);
	const working = $derived(adeTasks.counts.inProgress > 0);

	$effect(() => system.start());
	// Auto mode follows the agents; the backend only holds caffeinate while it is wanted.
	$effect(() => void system.applyKeepAwake(mode, working));

	const s = $derived(system.stats);
	const ours = $derived((system.ports ?? []).filter((p) => p.ours));
	const external = $derived((system.ports ?? []).filter((p) => !p.ours));

	/** Every process below `pid` (a terminal's shell and what runs in it). */
	function subtree(pid: number, rows: ProcessRow[]): ProcessRow[] {
		const out = rows.filter((p) => p.pid === pid);
		for (let i = 0; i < out.length; i++) for (const p of rows) if (p.ppid === out[i].pid && !out.includes(p)) out.push(p);
		return out;
	}
	const terminals = $derived.by(() => {
		const rows = s?.processes ?? [];
		const groups = new Map<string, { id: string; pid: number | null; rss: number; command: string }[]>();
		for (const t of s?.terminals ?? []) {
			const tree = t.pid === null ? [] : subtree(t.pid, rows);
			// The busiest program in the terminal names it (`claude`, `bun`), else the shell.
			const busiest = [...tree].sort((a, b) => b.rss_bytes - a.rss_bytes)[0];
			const g = terminalGroup(t.cwd, workspace.root);
			groups.set(g, [...(groups.get(g) ?? []), { id: t.id, pid: t.pid, rss: tree.reduce((n, p) => n + p.rss_bytes, 0), command: busiest?.name ?? 'shell' }]);
		}
		return [...groups];
	});
	/** Processes outside the terminals: language servers, agent hosts, caffeinate. */
	const others = $derived.by(() => {
		const rows = s?.processes ?? [];
		const inTerminals = new Set((s?.terminals ?? []).flatMap((t) => (t.pid === null ? [] : subtree(t.pid, rows).map((p) => p.pid))));
		return rows.filter((p) => !inTerminals.has(p.pid)).slice(0, 6);
	});

	function toggle(which: Open, e: MouseEvent) {
		anchor = e.currentTarget as HTMLElement;
		confirming = null;
		open = open === which ? null : which;
		if (open === 'ports') void system.refreshPorts();
		if (open === 'resources') void system.refresh();
	}
	const close = () => ((open = null), (confirming = null));
	const setMode = (m: KeepAwakeMode) => settings.set('kingu.keepAwake', m === 'off' ? undefined : m, 'user');

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		status.flash(`คัดลอก ${text} แล้ว`, 2500);
	}

	const ITEM = 'flex h-full items-center gap-1 px-2 tabular-nums hover:bg-(--vscode-toolbar-hoverBackground) aria-expanded:bg-(--vscode-toolbar-hoverBackground)';
	const HEAD = 'flex h-9 shrink-0 items-center gap-2 border-b border-(--vscode-widget-border) px-3';
	const SECTION = 'px-3 pt-2.5 pb-1 text-[11px] font-medium text-(--vscode-descriptionForeground) uppercase';
	const ROW_BTN = 'grid size-6 shrink-0 place-items-center rounded-md text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)';
</script>

{#if s}
	{#if showAwake && s.keep_awake !== null}
		<button
			class={ITEM}
			aria-haspopup="dialog"
			aria-expanded={open === 'awake'}
			aria-label="กันเครื่องหลับ: {mode}, {s.keep_awake ? 'Active' : 'Inactive'}"
			title="กันเครื่องหลับ: {KEEP_AWAKE_MODES.find((m) => m.id === mode)?.description}"
			onclick={(e) => toggle('awake', e)}
		>
			<Icon name="coffee" size={14} />
			<span class="text-[11px] font-medium">{KEEP_AWAKE_MODES.find((m) => m.id === mode)?.label}</span>
			<span aria-hidden="true" class={['size-1.5 rounded-full', s.keep_awake ? 'bg-current' : 'bg-current opacity-30']}></span>
		</button>
	{/if}
	{#if showResources && s.memory_bytes !== null}
		<button
			class={ITEM}
			aria-haspopup="dialog"
			aria-expanded={open === 'resources'}
			title="Resource Manager — {formatBytes(s.memory_bytes)} · {s.terminals.length} terminal"
			onclick={(e) => toggle('resources', e)}
		>
			<Icon name="memory" size={14} />{formatBytes(s.memory_bytes)}
			<span class="opacity-50">·</span>
			<Icon name="terminal" size={14} />{s.terminals.length}
		</button>
	{/if}
	{#if showPorts && system.ports}
		<button class={ITEM} aria-haspopup="dialog" aria-expanded={open === 'ports'} title="พอร์ตที่เปิดอยู่ ({ours.length} จาก Kingu)" onclick={(e) => toggle('ports', e)}>
			<Icon name="ports" size={14} />{ours.length}
		</button>
	{/if}
{/if}

{#if open && anchor && s}
	{#if open === 'awake'}
		<StatusPopover {anchor} label="กันเครื่องหลับ" width={256} onClose={close}>
			<div class="{HEAD} justify-between">
				<span class="font-medium">Keep Awake</span>
				<span class="text-xs text-(--vscode-descriptionForeground)">{s.keep_awake ? 'Active' : 'Inactive'}</span>
			</div>
			<div class="p-1" role="radiogroup" aria-label="โหมด">
				{#each KEEP_AWAKE_MODES as m (m.id)}
					<button
						role="radio"
						aria-checked={mode === m.id}
						class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--vscode-list-hoverBackground)"
						onclick={() => (setMode(m.id), close())}
					>
						<span class="mt-0.5 grid size-4 shrink-0 place-items-center">{#if mode === m.id}<Icon name="check" size={14} />{/if}</span>
						<span class="flex flex-col">
							<span>{m.label}</span>
							<span class="text-[11px] text-(--vscode-descriptionForeground)">{m.description}</span>
						</span>
					</button>
				{/each}
			</div>
		</StatusPopover>
	{:else if open === 'resources'}
		<StatusPopover {anchor} label="Resource Manager" width={340} onClose={close}>
			<div class="{HEAD} justify-between">
				<span class="font-medium">Resource Manager</span>
				<button class={ROW_BTN} aria-label="รีเฟรช" title="รีเฟรช" onclick={() => system.refresh()}><Icon name="refresh" size={14} /></button>
			</div>
			<div class="grid grid-cols-2 gap-2 border-b border-(--vscode-widget-border) px-3 py-2.5">
				<div title="ผลรวม RSS ของ Kingu และโปรเซสลูก หน้าหน่วยความจำที่ใช้ร่วมกันอาจถูกนับซ้ำ (ไม่รวม WebView)">
					<div class="text-[11px] text-(--vscode-descriptionForeground)">หน่วยความจำ</div>
					<div class="flex items-center gap-2">
						<span class="font-medium tabular-nums">{s.memory_bytes === null ? '—' : formatBytes(s.memory_bytes)}</span>
						<svg width="56" height="16" class="text-(--vscode-textLink-foreground)" aria-hidden="true">
							<polyline points={sparkline(system.samples, 56, 16)} fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
						</svg>
					</div>
				</div>
				<div title="CPU รวม เกิน 100% หมายถึงใช้มากกว่าหนึ่งคอร์">
					<div class="text-[11px] text-(--vscode-descriptionForeground)">CPU</div>
					<div class="font-medium tabular-nums">{s.cpu_percent === null ? '—' : `${s.cpu_percent.toFixed(0)}%`}</div>
				</div>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto pb-1.5">
				<div class={SECTION}>Terminal ({s.terminals.length})</div>
				{#each terminals as [group, list] (group)}
					<div class="flex items-center gap-1.5 px-3 pt-1 text-xs text-(--vscode-descriptionForeground)"><Icon name="folder" size={12} />{group}</div>
					{#each list as t (t.id)}
						<div class="group flex h-7 items-center gap-2 pr-1.5 pl-6 hover:bg-(--vscode-list-hoverBackground)">
							<Icon name="terminal" size={13} />
							<span class="min-w-0 flex-1 truncate">{t.command}</span>
							<span class="text-xs text-(--vscode-descriptionForeground) tabular-nums">{formatBytes(t.rss)}</span>
							{#if t.pid !== null}
								{#if confirming === t.id}
									<button class="rounded-md bg-(--vscode-errorForeground) px-2 text-xs leading-5 text-white" title="บังคับปิด terminal นี้ งานที่ยังไม่บันทึกในนั้นจะหายและย้อนกลับไม่ได้" onclick={() => (system.kill(t.pid!, t.command), (confirming = null))}>ยืนยัน</button>
								{:else}
									<button class="{ROW_BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label="ปิด {t.command}" title="ปิด terminal นี้" onclick={() => (confirming = t.id)}><Icon name="stopProcess" size={14} /></button>
								{/if}
							{/if}
						</div>
					{/each}
				{:else}
					<p class="px-3 py-1 text-xs text-(--vscode-descriptionForeground)">ยังไม่มี terminal</p>
				{/each}
				<div class={SECTION}>โปรเซสอื่น</div>
				{#each others as p (p.pid)}
					<div class="group flex h-7 items-center gap-2 px-3 pr-1.5 hover:bg-(--vscode-list-hoverBackground)">
						<Icon name="cpu" size={13} />
						<span class="min-w-0 flex-1 truncate" title="pid {p.pid}">{p.name}</span>
						<span class="text-xs text-(--vscode-descriptionForeground) tabular-nums">{formatBytes(p.rss_bytes)}</span>
						{#if confirming === `pid:${p.pid}`}
							<button class="rounded-md bg-(--vscode-errorForeground) px-2 text-xs leading-5 text-white" onclick={() => (system.kill(p.pid, p.name), (confirming = null))}>ยืนยัน</button>
						{:else}
							<button class="{ROW_BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label="หยุด {p.name}" title="หยุดโปรเซสนี้" onclick={() => (confirming = `pid:${p.pid}`)}><Icon name="stopProcess" size={14} /></button>
						{/if}
					</div>
				{:else}
					<p class="px-3 py-1 text-xs text-(--vscode-descriptionForeground)">ไม่มีอะไรรันอยู่ตอนนี้</p>
				{/each}
			</div>
		</StatusPopover>
	{:else if open === 'ports'}
		<StatusPopover {anchor} label="Ports" width={320} onClose={close}>
			<div class="{HEAD} justify-between">
				<span class="font-medium">Ports</span>
				<button class={ROW_BTN} aria-label="สแกนใหม่" title="สแกนใหม่" disabled={system.scanning} onclick={() => system.refreshPorts()}>
					<span class={system.scanning ? 'animate-spin' : ''}><Icon name="refresh" size={14} /></span>
				</button>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto pb-1.5">
				{#if system.portsError}
					<p class="px-3 py-2 text-xs text-(--vscode-errorForeground)">สแกนพอร์ตไม่ได้: {system.portsError}</p>
				{/if}
				{#each [['พอร์ตจาก Kingu', ours, 'ยังไม่พบพอร์ตจาก terminal หรือ agent'], ['พอร์ตภายนอก', external, 'ไม่พบพอร์ตภายนอก']] as const as [title, list, empty] (title)}
					<div class={SECTION}>{title}</div>
					{#each list as p (`${p.pid}:${p.port}`)}
						<div class="group flex h-7 items-center gap-2 px-3 pr-1.5 hover:bg-(--vscode-list-hoverBackground)">
							<span class="w-16 shrink-0 font-mono tabular-nums">:{p.port}</span>
							<span class="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)" title="{p.name} · pid {p.pid} · {p.address}">{p.name}</span>
							<button class={ROW_BTN} aria-label="เปิด localhost:{p.port} ในเบราว์เซอร์" title="เปิดในเบราว์เซอร์" onclick={() => system.openPort(p.port)}><Icon name="openExternal" size={14} /></button>
							<button class={ROW_BTN} aria-label="คัดลอก URL" title="คัดลอก http://localhost:{p.port}" onclick={() => copy(`http://localhost:${p.port}`)}><Icon name="copy" size={14} /></button>
							{#if p.ours}
								{#if confirming === `port:${p.pid}:${p.port}`}
									<button class="rounded-md bg-(--vscode-errorForeground) px-2 text-xs leading-5 text-white" onclick={() => (system.kill(p.pid, `${p.name} :${p.port}`), (confirming = null))}>ยืนยัน</button>
								{:else}
									<button class={ROW_BTN} aria-label="หยุด {p.name}" title="หยุดโปรเซส" onclick={() => (confirming = `port:${p.pid}:${p.port}`)}><Icon name="stopProcess" size={14} /></button>
								{/if}
							{/if}
						</div>
					{:else}
						<p class="px-3 py-1 text-xs text-(--vscode-descriptionForeground)">{system.scanning && !system.ports ? 'กำลังสแกนพอร์ต…' : empty}</p>
					{/each}
				{/each}
			</div>
		</StatusPopover>
	{/if}
{/if}
