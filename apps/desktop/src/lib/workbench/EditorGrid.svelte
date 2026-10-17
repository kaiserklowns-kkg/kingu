<script lang="ts">
	// A node of the editor group grid (VS Code: EditorPart's SerializableGrid): a group, or a split
	// laying its children out side by side (row) or stacked (column), resizable with sashes.
	import EditorGrid from './EditorGrid.svelte';
	import EditorGroupView from './EditorGroupView.svelte';
	import Sash from './Sash.svelte';
	import { editors, type GridNode } from './editors.svelte';

	let { node }: { node: GridNode } = $props();

	let el = $state<HTMLDivElement>();
	const row = $derived(node.type === 'split' && node.direction === 'row');
	const keyOf = (n: GridNode) => `${n.type}:${n.id}`;
</script>

{#if node.type === 'group'}
	<EditorGroupView group={node.id} />
{:else}
	<div bind:this={el} class={['flex h-full w-full min-h-0 min-w-0', row ? 'flex-row' : 'flex-col']}>
		{#each node.children as child, i (keyOf(child))}
			{#if i > 0}
				<Sash
					orientation={row ? 'vertical' : 'horizontal'}
					onDrag={(d) => {
						const total = (row ? el?.clientWidth : el?.clientHeight) || 1;
						editors.resize(node.id, i - 1, d / total);
					}}
					onReset={() => editors.evenSplit(node.id)}
				/>
			{/if}
			<div
				class={['min-h-0 min-w-0 overflow-hidden', i > 0 && (row ? 'border-l' : 'border-t'), 'border-(--vscode-editorGroup-border)']}
				style:flex="{node.sizes[i]} 1 0px"
			>
				<EditorGrid node={child} />
			</div>
		{/each}
	</div>
{/if}
