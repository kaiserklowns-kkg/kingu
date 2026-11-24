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
	import { invoke } from '@tauri-apps/api/core';
	import { open } from '@tauri-apps/plugin-dialog';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { cookieImportFailureText, cookieImportMessages, cookiePickRows, cookiePickSource, readCookieImportLastUsed, rememberCookieImportLastUsed, type CookieImportFrom, type CookieImportSummary, type CookieSource } from './cookieImport';

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
				{ id: 'new', label: t('ade.browserProfile.new') },
				{ id: 'clear', label: t('ade.cookieClear.action'), description: t('ade.cookieClear.row', { profile: profileName }), separator: ' ' }
			]
		});
		if (!pick) return;
		if (pick.id === 'clear') return clearCookies();
		if (pick.id === 'default') return adeLayout.setBrowserProfile(worktree, id, null);
		if (pick.id.startsWith('p:')) return adeLayout.setBrowserProfile(worktree, id, pick.id.slice(2));
		const name = await quick.input({ placeholder: t('ade.browserProfile.namePlaceholder'), hint: (v) => (cleanProfile(v) ? t('ade.browserProfile.useNew', { name: v.trim() }) : t('ade.browserProfile.nameHint')) });
		const clean = name ? cleanProfile(name) : null;
		if (clean) adeLayout.setBrowserProfile(worktree, id, clean);
	}
	const profileName = $derived(profile || t('ade.browserProfile.default'));
	// Orca fd60d2198, Settings › Browser › Cookies: Clear cookies… for this tab's profile, after a
	// confirmation. Every site in the profile signs out; other profiles keep their cookies.
	async function clearCookies() {
		const into = profile;
		const name = profileName;
		if (!(await ask(t('ade.cookieClear.confirmTitle', { profile: name }), { title: t('ade.cookieClear.confirmDescription'), kind: 'warning', okLabel: t('ade.cookieClear.clear') }))) return;
		try {
			await invoke<number>('browser_cookie_clear', { profile: into });
			notifications.info(t('ade.cookieClear.cleared', { profile: name }));
		} catch {
			notifications.error(t('ade.cookieClear.failed', { profile: name }));
		}
	}
	// Orca's Import Cookies: from Chrome or Edge (a profile of theirs) or a cookie file, into this
	// tab's profile. Only the imported domains are replaced; Google logins are never imported.
	let importing = $state(false);
	async function importCookies() {
		if (importing) return;
		const into = profile;
		const sources = await invoke<CookieSource[]>('browser_cookie_sources').catch(() => [] as CookieSource[]);
		// Orca 4a4cbdfc9: a search over the profiles, a Last used row, a group per browser, then
		// From File… and the Google note (which imports nothing).
		const lastUsed = readCookieImportLastUsed();
		const fixed = (searching: boolean, noMatches: boolean) => [
			{ id: 'file', label: t('ade.cookieImport.fromFile'), separator: searching ? undefined : ' ', ...(noMatches ? { description: t('ade.cookieImport.noMatches') } : {}) },
			{ id: 'google', label: t('ade.cookieImport.googleTitle'), description: t('ade.cookieImport.googleDescription') }
		];
		const pick = await quick.choose({
			placeholder: t('ade.cookieImport.search', { profile: into || t('ade.browserProfile.default') }),
			items: [],
			dynamic: (q) => {
				const rows = cookiePickRows(sources, lastUsed, q, t('ade.cookieImport.lastUsed'));
				return [...rows, ...fixed(!!q.trim(), !!q.trim() && rows.length === 0)];
			}
		});
		if (!pick || pick.id === 'google') return;
		let from: CookieImportFrom;
		let success: (count: number) => string;
		if (pick.id === 'file') {
			const path = await open({ multiple: false, directory: false, filters: [{ name: t('ade.cookieImport.fileFilter'), extensions: ['json'] }] });
			if (typeof path !== 'string') return;
			from = { kind: 'file', path };
			success = (count) => t('ade.cookieImport.importedFile', { count });
		} else {
			const picked = cookiePickSource(pick.id);
			const source = sources.find((s) => s.browser === picked?.browser);
			if (!picked || !source) return;
			const browserProfile = source.profiles.find((p) => p.directory === picked.directory);
			if (picked.directory !== null && !browserProfile) return;
			rememberCookieImportLastUsed(picked);
			from = { kind: 'browser', browser: source.browser, directory: picked.directory };
			success = (count) =>
				source.profiles.length > 1 && browserProfile
					? t('ade.cookieImport.importedProfile', { count, browser: source.label, profile: browserProfile.name })
					: t('ade.cookieImport.imported', { count, browser: source.label });
		}
		importing = true;
		status.flash(t('ade.cookieImport.importing'));
		try {
			const summary = await invoke<CookieImportSummary>('browser_cookie_import', { profile: into, from });
			const { info, warnings } = cookieImportMessages(summary, success(summary.imported));
			if (info) notifications.info(info);
			for (const w of warnings) notifications.warn(w);
		} catch (e) {
			status.error(cookieImportFailureText(e));
		} finally {
			importing = false;
		}
	}
	// In view for Memory Saver: the tab shows in the open worktree. Quick Input, Settings or the
	// floating workspace passing over it is not the user leaving the tab.
	const viewed = $derived(adeLayout.key === worktree && (adeLayout.activeTab(worktree) === id || (!!adeLayout.treeOf(worktree) && hasLeaf(adeLayout.treeOf(worktree)!, id))) && !adeLayout.board);
	const visible = $derived(viewed && !floating.open && !quick.visible && !systemSettings.visible);
</script>

<!-- A new profile is a new page view (WebKit fixes a view's data store when it is made). -->
{#key label}
<BrowserSurface
	{label}
	url={tab?.url ?? ''}
	{visible}
	{viewed}
	onTitle={(title) => adeLayout.renameBrowser(worktree, id, title)}
	onNavigate={(url) => adeLayout.setBrowserUrl(worktree, id, url)}
	onPick={(el, shot) => void draftPrompt(worktree, pickedPrompt(el, shot), t('ade.design.what', { selector: el.selector }))}
	{profile}
	onProfile={pickProfile}
	onImportCookies={importCookies}
	onNewTab={() => adeLayout.newBrowser(worktree)}
	frame=""
	padding=""
/>
{/key}
