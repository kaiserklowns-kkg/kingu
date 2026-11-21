<script lang="ts">
	import { page } from '$app/state';

	let { next, paged }: { next: string | null; paged: boolean } = $props();

	function href(cursor: string | null): string {
		const u = new URL(page.url.href);
		if (cursor) u.searchParams.set('cursor', cursor);
		else u.searchParams.delete('cursor');
		return `${u.pathname}${u.search}`;
	}
</script>

{#if next || paged}
	<nav aria-label="หน้า" class="mt-3 flex gap-2">
		{#if paged}<a href={href(null)} class="rounded-sm border border-(--vscode-widget-border) px-2 py-0.5 no-underline hover:bg-(--vscode-toolbar-hoverBackground)">กลับหน้าแรก</a>{/if}
		{#if next}<a href={href(next)} class="rounded-sm border border-(--vscode-widget-border) px-2 py-0.5 no-underline hover:bg-(--vscode-toolbar-hoverBackground)">หน้าถัดไป</a>{/if}
	</nav>
{/if}
