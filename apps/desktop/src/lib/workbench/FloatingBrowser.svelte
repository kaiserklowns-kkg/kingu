<script lang="ts">
	// A browser tab of the floating workspace: the shared browser surface, shown while this tab is
	// the panel's active one. The 8px gutter keeps the panel's resize handles reachable, since the
	// native page view sits above the page's HTML.
	import { untrack } from 'svelte';
	import { floating } from './floating.svelte';
	import { quick } from './quick.svelte';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import BrowserSurface from './BrowserSurface.svelte';

	let { id, url = '' }: { id: string; url?: string } = $props();
	const label = untrack(() => floating.browserLabel(id));
	const visible = $derived(floating.open && floating.active === id && !quick.visible && !systemSettings.visible);
</script>

<BrowserSurface {label} {url} {visible} onTitle={(title) => floating.rename(id, title)} onNewTab={() => floating.newBrowser()} />
