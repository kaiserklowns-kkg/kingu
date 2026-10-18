<script lang="ts">
	// Window controls we draw ourselves, for OSes whose title bar is ours (macOS draws its own
	// traffic lights). Windows 11 caption buttons: 46px wide, close turns red. Oceans: a placeholder
	// until its design guidelines arrive. Prepared, not live: only the platform preview shows them.
	// Enabling for real needs `core:window:allow-minimize`, `allow-toggle-maximize` and `allow-close`
	// in capabilities/default.json and an undecorated window on that OS.
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { platform } from './platform.svelte';

	const win = () => getCurrentWindow();
	const run = (f: () => Promise<void>) => void f().catch(() => {});
</script>

{#if platform.profile.windowControls === 'caption-right'}
	<div class="flex h-full shrink-0 items-stretch" style:width="{platform.profile.rightControlsWidth}px" data-tauri-drag-region="false">
		<button class="kg-caption" aria-label="Minimize" title="Minimize" onclick={() => run(() => win().minimize())}>
			<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1" /></svg>
		</button>
		<button class="kg-caption" aria-label="Maximize" title="Maximize" onclick={() => run(() => win().toggleMaximize())}>
			<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1" /></svg>
		</button>
		<button class="kg-caption kg-caption-close" aria-label="Close" title="Close" onclick={() => run(() => win().close())}>
			<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" /></svg>
		</button>
	</div>
{:else if platform.profile.windowControls === 'oceans'}
	<!-- Oceans placeholder: round controls at the right. Replace with the Oceans guidelines. -->
	<div class="flex h-full shrink-0 items-center justify-end gap-2 pr-3" style:width="{platform.profile.rightControlsWidth}px" data-tauri-drag-region="false">
		<button class="kg-ocean" aria-label="Minimize" title="Minimize" onclick={() => run(() => win().minimize())}></button>
		<button class="kg-ocean" aria-label="Maximize" title="Maximize" onclick={() => run(() => win().toggleMaximize())}></button>
		<button class="kg-ocean kg-ocean-close" aria-label="Close" title="Close" onclick={() => run(() => win().close())}></button>
	</div>
{/if}

<style>
	.kg-caption {
		display: grid;
		width: 46px;
		place-items: center;
		color: var(--vscode-titleBar-activeForeground);
	}
	.kg-caption:hover {
		background: var(--vscode-toolbar-hoverBackground);
	}
	.kg-caption-close:hover {
		background: #c42b1c;
		color: #fff;
	}
	.kg-ocean {
		width: 14px;
		height: 14px;
		border-radius: 999px;
		background: var(--vscode-widget-border);
	}
	.kg-ocean:hover {
		background: var(--vscode-descriptionForeground);
	}
	.kg-ocean-close:hover {
		background: #e5484d;
	}
</style>
