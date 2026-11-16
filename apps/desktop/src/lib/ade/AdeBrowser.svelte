<script lang="ts">
	// A browser tab of the Agents layout (Orca's browser tabs): the shared browser surface over
	// `adeLayout.browsers`. The native page view is hidden while the floating workspace is open, so
	// the panel (page HTML) always stays in front of it.
	import { adeLayout, browserLabel } from './adeLayout.svelte';
	import { hasLeaf } from '#lib/terminal/paneLayout.ts';
	import { quick } from '#lib/workbench/quick.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { floating } from '#lib/workbench/floating.svelte.ts';
	import BrowserSurface from '#lib/workbench/BrowserSurface.svelte';
	import { pickedPrompt } from '#lib/workbench/floating.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { draftPrompt } from './agentTarget.svelte';
	import { t } from '#lib/i18n/index.ts';

	let { worktree, id }: { worktree: string; id: string } = $props();
	const tab = $derived(adeLayout.browserTab(worktree, id));
	const visible = $derived(
		adeLayout.key === worktree && (adeLayout.activeTab(worktree) === id || !!adeLayout.treeOf(worktree) && hasLeaf(adeLayout.treeOf(worktree)!, id)) && !adeLayout.board && !floating.open && !quick.visible && !systemSettings.visible
	);
</script>

<BrowserSurface
	label={browserLabel(worktree, id)}
	url={tab?.url ?? ''}
	{visible}
	onTitle={(title) => adeLayout.renameBrowser(worktree, id, title)}
	onNavigate={(url) => adeLayout.setBrowserUrl(worktree, id, url)}
	onPick={(el) => void draftPrompt(worktree, pickedPrompt(el), t('ade.design.what', { selector: el.selector }))}
	profile={settings.get<string>('kingu.browser.profile') ?? ''}
	onNewTab={() => adeLayout.newBrowser(worktree)}
	frame=""
	padding=""
/>
