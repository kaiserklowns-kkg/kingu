<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { commands, keyOf } from './commands.svelte';
	import { editors } from './editors.svelte';
	import FileIcon from './FileIcon.svelte';
	import { fileIcon, type FileIconSpec } from './fileIcons';
	import { quick, type PickItem, type Picker } from './quick.svelte';
	import { untrack } from 'svelte';
	import { rank, type Match } from './fuzzy';
	import { keyLabel } from './keys';

	type Item = { label: string; detail?: string; key?: string; match?: Match; icon?: FileIconSpec; separator?: string; pick?: PickItem; run: () => void };

	let input: HTMLInputElement | undefined = $state();
	let files = $state<string[]>([]);
	let index = $state(0);

	$effect(() => {
		if (!quick.visible) return;
		void quick.session;
		const p = untrack(() => quick.picker);
		index = p?.activeId ? Math.max(0, p.items.findIndex((i) => i.id === p.activeId)) : 0;
		queueMicrotask(() => input?.focus());
		if (p) return;
		invoke<string[]>('fs_list_files').then((v) => (files = v));
	});

	/** Custom pick list: original order (with group labels) until the user types. */
	function pickerItems(picker: Picker, q: string): Item[] {
		const list = picker.items;
		const toItem = (pick: PickItem, match?: Match): Item => ({ label: pick.label, detail: pick.description, separator: q ? undefined : pick.separator, match, pick, run: () => picker.onAccept(pick) });
		if (picker.dynamic) return picker.dynamic(q).map((p) => toItem(p));
		if (!q) return list.map((p) => toItem(p));
		return rank(q, list, (p) => p.label, 100).map(({ item, match }) => toItem(item, match));
	}

	// Focus changes preview the item (VS Code's color theme picker applies the theme live).
	$effect(() => {
		const pick = items[index]?.pick;
		const onActive = quick.picker?.onActive;
		if (pick && onActive) untrack(() => onActive(pick));
	});

	const items = $derived.by((): Item[] => {
		if (quick.picker) return pickerItems(quick.picker, quick.value.trim());
		const v = quick.value;
		if (v.startsWith('>')) {
			const q = v.slice(1).trim();
			const all = commands.paletteItems();
			const label = (c: (typeof all)[number]) => (c.category ? `${c.category}: ${c.title}` : c.title);
			return rank(q, all, label, 100).map(({ item, match }) => ({
				label: label(item),
				key: keyOf(item),
				match,
				run: () => commands.run(item.id)
			}));
		}
		if (v.startsWith(':')) {
			const [line, col] = v.slice(1).split(/[:,]/).map((n) => parseInt(n, 10));
			if (!editors.active) return [{ label: 'เปิดไฟล์ก่อนแล้วจึงไปบรรทัดได้', run: () => {} }];
			return [
				{
					label: Number.isFinite(line) ? `ไปบรรทัด ${line}${Number.isFinite(col) ? `, คอลัมน์ ${col}` : ''}` : 'พิมพ์เลขบรรทัด เช่น :42 หรือ :42:5',
					run: () => Number.isFinite(line) && editors.gotoLine(line, Number.isFinite(col) ? col : 1)
				}
			];
		}
		return rank(v, files, (f) => f, 60).map(({ item, match }) => {
			const slash = item.lastIndexOf('/');
			return {
				label: item.slice(slash + 1),
				icon: fileIcon(item),
				detail: slash > 0 ? item.slice(0, slash) : '',
				match: { score: match.score, positions: match.positions.filter((p) => p > slash).map((p) => p - slash - 1) },
				run: () => editors.open(item, { preview: true })
			};
		});
	});

	function accept(i = index) {
		const item = items[i];
		quick.hide({ accepted: true });
		item?.run();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') quick.hide();
		else if (e.key === 'ArrowDown') index = Math.min(index + 1, items.length - 1);
		else if (e.key === 'ArrowUp') index = Math.max(index - 1, 0);
		else if (e.key === 'Enter') accept();
		else return;
		e.preventDefault();
	}

	function parts(text: string, positions: number[] = []) {
		const set = new Set(positions);
		return [...text].map((ch, i) => ({ ch, hit: set.has(i) }));
	}
</script>

{#if quick.visible}
	<!-- VS Code: 600px wide (or 62% of the window), just below the title bar, no backdrop. -->
	<div
		role="dialog"
		aria-label="Quick open"
		tabindex="-1"
		class="fixed top-[calc(var(--kg-titlebar-height)+2px)] left-1/2 z-50 w-[min(600px,62vw)] -translate-x-1/2 rounded-md border border-(--vscode-widget-border) bg-(--vscode-quickInput-background) p-1.5 text-(--vscode-quickInput-foreground) shadow-[0_0_8px_2px_rgba(0,0,0,0.36)]"
		onfocusout={(e) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node | null)) quick.hide();
		}}
	>
		<input
			bind:this={input}
			bind:value={quick.value}
			oninput={() => (index = 0)}
			onkeydown={onKey}
			aria-label="ค้นหาไฟล์ พิมพ์ > เพื่อดูคำสั่ง หรือ : เพื่อไปบรรทัด"
			placeholder={quick.picker?.placeholder ?? 'ค้นหาไฟล์ตามชื่อ (พิมพ์ > สำหรับคำสั่ง, : สำหรับไปบรรทัด)'}
			class="h-[26px] w-full rounded-sm border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1.5 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground)"
		/>
		<ul role="listbox" aria-label="ผลลัพธ์" class="mt-1 max-h-[440px] overflow-y-auto">
			{#each items as item, i (i)}
				<li role="option" aria-selected={i === index}>
					<button
						tabindex="-1"
						class={[
							'flex h-(--kg-row-height) w-full items-center gap-2 rounded-sm px-1.5 text-left',
							i === index ? 'bg-(--vscode-quickInputList-focusBackground) text-(--vscode-list-activeSelectionForeground)' : 'hover:bg-(--vscode-list-hoverBackground)'
						]}
						onmousemove={() => (index = i)}
						onclick={() => accept(i)}
					>
						{#if item.icon}<FileIcon icon={item.icon} />{/if}
						<span class="truncate">
							{#each parts(item.label, item.match?.positions) as p, k (k)}<span class={p.hit ? 'font-bold text-(--vscode-list-highlightForeground)' : undefined}>{p.ch}</span>{/each}
						</span>
						{#if item.detail}<span class="truncate text-xs text-(--vscode-descriptionForeground)">{item.detail}</span>{/if}
						{#if item.separator}<span class="ml-auto shrink-0 text-xs text-(--vscode-descriptionForeground)">{item.separator}</span>{/if}
						{#if item.key}<span class="ml-auto shrink-0 font-mono text-xs text-(--vscode-descriptionForeground)">{keyLabel(item.key)}</span>{/if}
					</button>
				</li>
			{:else}
				<li class="px-1.5 py-1 text-(--vscode-descriptionForeground)">ไม่พบผลลัพธ์</li>
			{/each}
		</ul>
	</div>
{/if}
