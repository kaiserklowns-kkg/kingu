<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const nav = [
		{ href: '/', label: 'บอร์ดทีม' },
		{ href: '/runs', label: 'ประวัติการรัน' }
	];
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-(--vscode-button-background) focus:px-3 focus:py-1 focus:text-(--vscode-button-foreground)"
	>ข้ามไปเนื้อหา</a
>

{#if data.me}
	<header class="sticky top-0 z-10 border-b border-(--vscode-titleBar-border) bg-(--vscode-titleBar-activeBackground)">
		<div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
			<span class="font-semibold text-(--vscode-tab-activeForeground)">Kingu ทีม</span>
			<nav aria-label="หลัก" class="flex gap-1">
				{#each nav as item (item.href)}
					<a
						href={item.href}
						aria-current={page.url.pathname === item.href ? 'page' : undefined}
						class={[
							'rounded-sm px-2 py-1 no-underline hover:bg-(--vscode-toolbar-hoverBackground)',
							page.url.pathname === item.href ? 'text-(--vscode-tab-activeForeground) shadow-[inset_0_-2px_0_var(--vscode-panelTitle-activeBorder)]' : 'text-(--vscode-tab-inactiveForeground)'
						]}>{item.label}</a
					>
				{/each}
			</nav>
			<div class="ml-auto flex items-center gap-3 text-(--vscode-descriptionForeground)">
				<span class="truncate" title={`${data.me.org_name} · ${data.me.role}`}>{data.me.user_id} · {data.me.org_name}</span>
				<form method="POST" action="/logout">
					<button type="submit" class="rounded-sm border border-(--vscode-widget-border) px-2 py-0.5 text-(--vscode-foreground) hover:bg-(--vscode-toolbar-hoverBackground)">ออกจากระบบ</button>
				</form>
			</div>
		</div>
	</header>
{/if}

<div id="main" tabindex="-1" class="outline-none">
	{@render children()}
</div>
