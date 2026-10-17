<script lang="ts">
	import ExplorerView from './ExplorerView.svelte';
	import Icon from './Icon.svelte';
	import { layout } from './layout.svelte';
	import { status } from './status.svelte';
	import { editors } from './editors.svelte';

	let { workspaceName }: { workspaceName: string } = $props();

	const titles = { explorer: 'Explorer', search: 'Search', scm: 'Source Control', agents: 'Agents' };
	const dirty = $derived(editors.tabs.filter((t) => t.dirty));
</script>

<aside aria-label={titles[layout.sideView]} class="flex h-full flex-col bg-(--vscode-sideBar-background) text-(--vscode-sideBar-foreground)">
	<div class="flex h-(--kg-part-title-height) shrink-0 items-center pl-5 text-[11px] text-(--vscode-sideBarTitle-foreground) uppercase">
		{titles[layout.sideView]}
	</div>

	{#if layout.sideView === 'explorer'}
		<ExplorerView {workspaceName} />
	{:else if layout.sideView === 'search'}
		<div class="px-3 py-1 text-(--vscode-descriptionForeground)">
			ค้นหาข้อความทั้ง workspace (ripgrep) อยู่ใน P1 · ตอนนี้ใช้ <b>⌘P</b> ค้นหาชื่อไฟล์ได้
		</div>
	{:else if layout.sideView === 'scm'}
		<div class="flex flex-col gap-1 px-3 py-1">
			<div class="flex items-center gap-1.5"><Icon name="branch" size={14} />{status.branch ?? 'ไม่ใช่ git repository'}</div>
			<div class="text-(--vscode-descriptionForeground)">
				{#if dirty.length}แก้ไว้ยังไม่บันทึก {dirty.length} ไฟล์{:else}รายการไฟล์ที่เปลี่ยนและ commit อยู่ใน P1{/if}
			</div>
		</div>
	{/if}
</aside>
