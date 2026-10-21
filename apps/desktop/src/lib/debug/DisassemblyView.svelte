<script lang="ts">
	// The Disassembly view (VS Code: DisassemblyView, an editor): the focused session's instructions
	// around the selected frame's instruction pointer, more fetched as it scrolls, the source lines
	// between them (`debug.disassemblyView.showSourceCode`), a breakpoint column for instruction
	// breakpoints, and stepping by instruction while it has focus.
	import { invoke } from '@tauri-apps/api/core';
	import { t } from '#lib/i18n/index.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { debug } from './debug.svelte.ts';
	import { disassemblyRows, formatBytes, indexOfAddress, mergeInstructions, PAGE, sameAddress } from './disassembly.ts';
	import type { DisassembledInstruction } from './protocol.ts';

	let instructions = $state.raw<DisassembledInstruction[]>([]);
	let loading = $state(false);
	let scroller: HTMLDivElement | undefined = $state();
	/** Source files' lines (workspace files read once), for the source rows. */
	let sources = $state.raw<Record<string, string[] | null>>({});

	const ip = $derived(debug.instructionPointer);
	const showSource = $derived(settings.get<boolean>('debug.disassemblyView.showSourceCode') !== false);
	const rows = $derived(disassemblyRows(instructions, ip, showSource));
	const supported = $derived(!!debug.capabilities.supportsDisassembleRequest);

	// A stop (or a frame click) outside what is loaded loads the instructions around it.
	$effect(() => {
		const at = ip;
		if (!at || !supported) return;
		if (indexOfAddress(instructions, at) >= 0) return void reveal(at);
		void load(at);
	});

	async function load(at: string) {
		loading = true;
		try {
			instructions = mergeInstructions([], await debug.disassemble(at, -PAGE, PAGE * 2));
		} finally {
			loading = false;
		}
		reveal(at);
	}

	function reveal(at: string) {
		queueMicrotask(() => scroller?.querySelector(`[data-address="${CSS.escape(at)}"]`)?.scrollIntoView({ block: 'center' }));
	}

	/** More instructions above or below as the view nears an end. */
	async function more() {
		if (!scroller || loading || !instructions.length) return;
		const top = scroller.scrollTop < 80;
		const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
		if (!top && !bottom) return;
		loading = true;
		try {
			if (top) {
				const before = scroller.scrollHeight;
				const got = await debug.disassemble(instructions[0].address, -PAGE, PAGE);
				instructions = mergeInstructions(instructions, got);
				// The rows added above keep the visible ones where they were.
				queueMicrotask(() => scroller && (scroller.scrollTop += scroller.scrollHeight - before));
			} else {
				instructions = mergeInstructions(instructions, await debug.disassemble(instructions[instructions.length - 1].address, 1, PAGE));
			}
		} finally {
			loading = false;
		}
	}

	// The source rows' text: workspace files are read once.
	$effect(() => {
		if (!showSource) return;
		for (const r of rows) {
			if (r.kind !== 'source' || r.path in sources) continue;
			const rel = r.path.startsWith(`${debug.root}/`) ? r.path.slice(debug.root.length + 1) : null;
			sources = { ...sources, [r.path]: null };
			if (rel) void invoke<string>('read_workspace_file', { rel }).then((text) => (sources = { ...sources, [r.path]: text.split('\n') }), () => {});
		}
	});

	const sourceText = (path: string, line: number, endLine: number) => {
		const lines = sources[path];
		return lines ? lines.slice(line - 1, endLine).join('\n') : '';
	};
	const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
	const hasBreakpoint = (address: string) => debug.instructionBreakpoints.find((b) => sameAddress(b.address, address));

	function openSource(path: string, line: number) {
		const rel = path.startsWith(`${debug.root}/`) ? path.slice(debug.root.length + 1) : null;
		if (rel) editors.openAt(rel, line);
	}
</script>

<section
	class="flex h-full min-h-0 flex-col bg-(--vscode-editor-background) font-(family-name:--vscode-editor-font-family) text-[12px] text-(--vscode-editor-foreground)"
	aria-label={t('debugExtras.disassembly.title')}
	onfocusin={() => (debug.disassemblyFocused = true)}
	onfocusout={() => (debug.disassemblyFocused = false)}
>
	<div class="flex h-[26px] shrink-0 items-center gap-3 border-b border-(--vscode-editorGroupHeader-tabsBorder,transparent) px-3 font-sans text-xs text-(--vscode-descriptionForeground)">
		<span class="truncate">{debug.configName ? `${debug.configName}: ${debug.label}` : t('debugExtras.disassembly.title')}</span>
		<label class="ml-auto flex items-center gap-1">
			<input type="checkbox" checked={showSource} onchange={(e) => void settings.set('debug.disassemblyView.showSourceCode', e.currentTarget.checked, 'user')} />
			{t('debugExtras.disassembly.showSource')}
		</label>
	</div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div bind:this={scroller} class="min-h-0 flex-1 overflow-auto outline-none" tabindex="0" role="grid" aria-label={t('debugExtras.disassembly.title')} onscroll={() => void more()}>
		{#if !supported}
			<p class="px-4 py-2 font-sans text-(--vscode-descriptionForeground)">{t('debugExtras.disassembly.unsupported')}</p>
		{:else if !ip && !instructions.length}
			<p class="px-4 py-2 font-sans text-(--vscode-descriptionForeground)">{t('debugExtras.disassembly.notStopped')}</p>
		{/if}
		{#each rows as row (row.key)}
			{#if row.kind === 'source'}
				<button class="flex w-full gap-2 py-0.5 pr-3 pl-[30px] text-left text-(--vscode-descriptionForeground) hover:underline" title={`${row.path}:${row.line}`} onclick={() => openSource(row.path, row.line)}>
					<span class="shrink-0">{fileName(row.path)}:{row.line}</span>
					<span class="min-w-0 truncate whitespace-pre">{sourceText(row.path, row.line, row.endLine)}</span>
				</button>
			{:else}
				{@const bp = hasBreakpoint(row.ins.address)}
				<div
					class={['flex h-[19px] items-center gap-3 pr-3 whitespace-pre', row.current && 'bg-(--vscode-editor-stackFrameHighlightBackground,rgba(255,255,0,0.2))', row.ins.presentationHint === 'invalid' && 'opacity-50']}
					data-address={row.ins.address}
					role="row"
				>
					<button
						class="grid h-full w-[22px] shrink-0 place-items-center"
						aria-label={bp ? t('debugExtras.disassembly.removeBreakpoint') : t('debugExtras.disassembly.addBreakpoint')}
						title={bp ? t('debugExtras.disassembly.removeBreakpoint') : t('debugExtras.disassembly.addBreakpoint')}
						disabled={!debug.capabilities.supportsInstructionBreakpoints}
						onclick={() => debug.toggleInstructionBreakpoint(row.ins.address)}
					>
						{#if row.current}
							<span class="text-(--vscode-debugIcon-continueForeground,#ffcc00)">➜</span>
						{:else if bp}
							<span class={['size-2.5 rounded-full', bp.enabled ? 'bg-(--vscode-debugIcon-breakpointForeground,#e51400)' : 'bg-(--vscode-debugIcon-breakpointDisabledForeground,#848484)']}></span>
						{/if}
					</button>
					<span class="w-[150px] shrink-0 text-(--vscode-editorLineNumber-foreground)">{row.ins.address}</span>
					<span class="w-[150px] shrink-0 truncate text-(--vscode-descriptionForeground)">{formatBytes(row.ins.instructionBytes)}</span>
					<span class="min-w-0 flex-1 truncate">{row.ins.instruction}</span>
					{#if row.ins.symbol}<span class="shrink-0 text-(--vscode-descriptionForeground)">{row.ins.symbol}</span>{/if}
				</div>
			{/if}
		{/each}
		{#if loading}<p class="px-4 py-1 font-sans text-(--vscode-descriptionForeground)">{t('debugExtras.loading')}</p>{/if}
	</div>
</section>
