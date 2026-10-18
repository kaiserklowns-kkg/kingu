<script lang="ts">
	// Debug Console (VS Code: repl.ts): the session's output and an expression input evaluated in
	// the selected stack frame. ↑/↓ walk the input history.
	import Icon from '#lib/workbench/Icon.svelte';
	import { debug } from './debug.svelte.ts';

	let input = $state('');
	let history: string[] = [];
	let historyAt = -1;
	let scroller: HTMLDivElement | undefined = $state();

	const output = $derived(debug.model?.output ?? []);

	// Follow the output while scrolled to the bottom.
	$effect(() => {
		void output.length;
		const el = scroller;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		if (atBottom) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && input.trim()) {
			const expr = input.trim();
			history = [expr, ...history.filter((h) => h !== expr)].slice(0, 100);
			historyAt = -1;
			input = '';
			void debug.repl(expr);
		} else if (e.key === 'ArrowUp' && history.length) {
			e.preventDefault();
			historyAt = Math.min(historyAt + 1, history.length - 1);
			input = history[historyAt];
		} else if (e.key === 'ArrowDown' && historyAt >= 0) {
			e.preventDefault();
			historyAt -= 1;
			input = historyAt >= 0 ? history[historyAt] : '';
		}
	}

	const color: Record<string, string> = {
		stderr: 'text-(--vscode-errorForeground)',
		important: 'text-(--vscode-editorWarning-foreground)',
		input: 'text-(--vscode-descriptionForeground)',
		console: 'text-(--vscode-descriptionForeground)'
	};
</script>

<div class="flex h-full flex-col">
	<div bind:this={scroller} class="relative min-h-0 flex-1 overflow-auto px-5 py-1 font-mono text-xs whitespace-pre-wrap">
		{#if output.length}
			<button aria-label="Clear Console" title="Clear Console" class="sticky top-0 float-right grid size-5 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground)" onclick={() => debug.clearConsole()}>
				<Icon name="trash" size={14} />
			</button>
			{#each output as line, i (i)}<span class={color[line.category]}>{line.text}</span>{/each}
		{:else}
			<span class="text-(--vscode-descriptionForeground)">{debug.active ? '' : 'เริ่ม debug (F5) แล้ว output ของโปรแกรมจะแสดงที่นี่'}</span>
		{/if}
	</div>
	<div class="flex shrink-0 items-center gap-1 border-t border-(--vscode-panel-border) px-2">
		<Icon name="chevronRight" size={14} />
		<input
			aria-label="Debug Console input"
			placeholder={debug.stopped ? 'ประเมินนิพจน์ใน frame ที่เลือก' : 'Debug Console'}
			bind:value={input}
			onkeydown={onKey}
			spellcheck="false"
			class="h-[26px] min-w-0 flex-1 bg-transparent font-mono text-xs text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
		/>
	</div>
</div>
