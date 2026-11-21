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
	import { cleanProfile } from './adeTabs';

	let { worktree, id }: { worktree: string; id: string } = $props();
	const tab = $derived(adeLayout.browserTab(worktree, id));
	// Orca's toolbar profile picker: the tab's own profile, else the app's default (kingu.browser.profile).
	const profile = $derived(tab?.profile ?? settings.get<string>('kingu.browser.profile') ?? '');
	const label = $derived(browserLabel(worktree, id, tab?.profile));
	async function pickProfile() {
		const fallback = settings.get<string>('kingu.browser.profile') ?? '';
		const names = [...new Set([fallback, ...adeLayout.browserProfiles()].filter(Boolean))];
		const pick = await quick.choose({
			placeholder: t('ade.browserProfile.pick'),
			items: [
				{ id: 'default', label: t('ade.browserProfile.default'), description: fallback ? t('ade.browserProfile.defaultIs', { name: fallback }) : t('ade.browserProfile.shared') },
				...names.map((n) => ({ id: `p:${n}`, label: n, description: n === profile ? t('ade.browserProfile.current') : '' })),
				{ id: 'new', label: t('ade.browserProfile.new') }
			]
		});
		if (!pick) return;
		if (pick.id === 'default') return adeLayout.setBrowserProfile(worktree, id, null);
		if (pick.id.startsWith('p:')) return adeLayout.setBrowserProfile(worktree, id, pick.id.slice(2));
		const name = await quick.input({ placeholder: t('ade.browserProfile.namePlaceholder'), hint: (v) => (cleanProfile(v) ? t('ade.browserProfile.useNew', { name: v.trim() }) : t('ade.browserProfile.nameHint')) });
		const clean = name ? cleanProfile(name) : null;
		if (clean) adeLayout.setBrowserProfile(worktree, id, clean);
	}
	const visible = $derived(
		adeLayout.key === worktree && (adeLayout.activeTab(worktree) === id || !!adeLayout.treeOf(worktree) && hasLeaf(adeLayout.treeOf(worktree)!, id)) && !adeLayout.board && !floating.open && !quick.visible && !systemSettings.visible
	);
</script>

<!-- A new profile is a new page view (WebKit fixes a view's data store when it is made). -->
{#key label}
<BrowserSurface
	{label}
	url={tab?.url ?? ''}
	{visible}
	onTitle={(title) => adeLayout.renameBrowser(worktree, id, title)}
	onNavigate={(url) => adeLayout.setBrowserUrl(worktree, id, url)}
	onPick={(el) => void draftPrompt(worktree, pickedPrompt(el), t('ade.design.what', { selector: el.selector }))}
	{profile}
	onProfile={pickProfile}
	onNewTab={() => adeLayout.newBrowser(worktree)}
	frame=""
	padding=""
/>
{/key}
