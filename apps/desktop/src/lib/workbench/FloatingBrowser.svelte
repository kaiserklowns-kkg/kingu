<script lang="ts">
	// A browser tab of the floating workspace: the shared browser surface, shown while this tab is
	// the panel's active one. The 8px gutter keeps the panel's resize handles reachable, since the
	// native page view sits above the page's HTML.
	import { untrack } from 'svelte';
	import { floating } from './floating.svelte';
	import { quick } from './quick.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import BrowserSurface from './BrowserSurface.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { sshWorkspace } from '#lib/ade/sshWorkspace.svelte.ts';
	import { sshHosts } from '#lib/ade/sshHosts.svelte.ts';

	let { id, url = '' }: { id: string; url?: string } = $props();
	// A page an agent opened keeps the label Rust gave its webview.
	const label = untrack(() => floating.tabs.find((t) => t.id === id)?.agent ?? floating.browserLabel(id));
	// In view for Memory Saver: Quick Input or Settings passing over the page is not leaving the tab.
	const viewed = $derived(floating.open && floating.active === id);
	const visible = $derived(viewed && !quick.visible && !systemSettings.visible);
	// A worktree on an SSH host is open: its localhost pages come from that host (kingu.browser.sshRouting).
	const host = $derived(settings.get<boolean>('kingu.browser.sshRouting') !== false ? (sshWorkspace.current?.project.host ?? null) : null);
	const route = $derived(
		host
			? {
					via: sshHosts.targets.find((t) => t.id === host)?.label ?? host,
					forward: async (port: number) => {
						const local = await invoke<number>('ssh_forward_for_browser', { targetId: host, remotePort: port });
						void sshHosts.refresh();
						return local;
					}
				}
			: undefined
	);
</script>

<BrowserSurface {label} {url} {visible} {viewed} {route} onTitle={(title) => floating.rename(id, title)} onNewTab={() => floating.newBrowser()} />
