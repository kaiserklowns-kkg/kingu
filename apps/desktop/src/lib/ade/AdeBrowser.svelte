<script lang="ts">
	// A browser tab of the Agents layout (Orca's browser tabs): the shared browser surface over
	// `adeLayout.browsers`. The native page view is hidden while the floating workspace is open, so
	// the panel (page HTML) always stays in front of it.
	import { adeLayout } from './adeLayout.svelte';
	import { quick } from '#lib/workbench/quick.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { floating } from '#lib/workbench/floating.svelte.ts';
	import BrowserSurface from '#lib/workbench/BrowserSurface.svelte';

	let { worktree, id }: { worktree: string; id: string } = $props();
	const tab = $derived(adeLayout.browserTab(worktree, id));
	const visible = $derived(
		adeLayout.key === worktree && adeLayout.activeTab(worktree) === id && !adeLayout.board && !floating.open && !quick.visible && !systemSettings.visible
	);
</script>

<BrowserSurface
	label="ade-browser-{worktree || 'primary'}-{id}"
	url={tab?.url ?? ''}
	{visible}
	onTitle={(title) => adeLayout.renameBrowser(worktree, id, title)}
	onNewTab={() => adeLayout.newBrowser(worktree)}
	frame=""
	padding=""
/>
