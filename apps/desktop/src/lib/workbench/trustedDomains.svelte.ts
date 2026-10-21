// Outgoing link protection (VS Code's "Do you want Code to open the external website?" and
// Manage Trusted Domains). Web links from editors, the Markdown preview, terminals and chat come
// here: a trusted domain (trustedDomains.ts) opens in the browser, any other asks first: Open,
// Configure Trusted Domains (trust the link, its domain with subdomains or every domain; copy the
// link; manage the list) or Cancel. The list is `<config dir>/trusted-domains.json` (Rust
// workspace_trust.rs), JSON with comments, edited in an editor tab and read before each prompt.

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { setEditorLinkHandler } from '#lib/editor/linkOpener.ts';
import { appendArrayElement, parseJsonc } from '#lib/settings/jsonc.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { choose } from './messageBox';
import { notifications } from './notifications.svelte';
import { quick } from './quick.svelte';
import { status } from './status.svelte';
import { displayLink, isUrlTrusted, isWebLink, linkNeedsPrompt, TRUSTED_DOMAINS_TEMPLATE, trustOptions } from './trustedDomains';
import { workspace } from './workspace.svelte';
import { workspaceTrust } from './workspaceTrust.svelte';

type DomainsFile = { path: string; content: string | null };

/** Where a link was clicked: the workspace's own content (editors, the Markdown preview) or not (terminals, chat, agent pages). */
export type LinkSource = { fromWorkspace: boolean };

class TrustedDomains {
	async #read(): Promise<{ text: string; domains: string[] }> {
		try {
			const f = await invoke<DomainsFile>('trusted_domains_read');
			const text = f.content ?? TRUSTED_DOMAINS_TEMPLATE;
			const parsed = parseJsonc<unknown>(text);
			return { text, domains: Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [] };
		} catch (e) {
			notifications.error(t('trust.domains.failed', { error: String(e) }));
			return { text: TRUSTED_DOMAINS_TEMPLATE, domains: [] };
		}
	}

	/** The trusted domains now (read from the file each time, so an edit applies once saved). */
	async domains(): Promise<string[]> {
		return (await this.#read()).domains;
	}

	/** Adds domains to the file, keeping its comments. */
	async add(domains: readonly string[]) {
		let { text } = await this.#read();
		for (const d of domains) text = appendArrayElement(text, d);
		await invoke('trusted_domains_write', { content: text });
	}

	/** Manage Trusted Domains: the list in an editor tab. */
	async manage() {
		try {
			const path = await invoke<string>('trusted_domains_open', { template: TRUSTED_DOMAINS_TEMPLATE });
			editors.open(workspace.keyFor(path), { preview: false });
		} catch (e) {
			notifications.error(t('trust.domains.failed', { error: String(e) }));
		}
	}

	/** Whether `url` may open: a trusted domain, or the user said so. Links other than web links pass. */
	async confirm(url: string, source: LinkSource): Promise<boolean> {
		if (!isWebLink(url)) return true;
		const trusted = await this.domains();
		const needs = linkNeedsPrompt(url, {
			trusted,
			fromWorkspace: source.fromWorkspace,
			workspaceTrusted: workspaceTrust.trusted,
			promptInTrustedWorkspace: settings.get<boolean>('workbench.trustedDomains.promptInTrustedWorkspace') === true
		});
		if (!needs) return true;
		const open = t('trust.link.open');
		const configure = t('trust.link.configure');
		const answer = await choose(`${t('trust.link.message')}\n\n${displayLink(url)}`, { kind: 'info', buttons: [open, configure, t('common.cancel')], cancelId: 2 });
		if (answer === open) return true;
		return answer === configure && this.#configure(url);
	}

	/** Configure Trusted Domains: trust the link, its domain or everything; copy it; or manage the list. True when it may open now. */
	async #configure(url: string): Promise<boolean> {
		const o = trustOptions(url);
		const items = [
			...(o ? [{ id: 'exact', label: t('trust.link.trustExact', { url: o.exact }) }, { id: 'domain', label: t('trust.link.trustDomain', { domain: o.domain }) }] : []),
			{ id: 'all', label: t('trust.link.trustAll') },
			{ id: 'copy', label: t('trust.link.copy') },
			{ id: 'manage', label: t('trust.link.manage') }
		];
		const pick = await quick.choose({ placeholder: t('trust.link.pick'), items });
		if (!pick) return false;
		if (pick.id === 'copy') {
			await navigator.clipboard.writeText(url).then(() => status.flash(t('trust.link.copied', { url }), 4000), () => {});
			return false;
		}
		if (pick.id === 'manage') {
			await this.manage();
			return false;
		}
		const domain = pick.id === 'all' ? '*' : pick.id === 'exact' ? o!.exact : o!.domain;
		try {
			await this.add([domain]);
		} catch (e) {
			notifications.error(t('trust.domains.failed', { error: String(e) }));
			return false;
		}
		return isUrlTrusted(url, [domain]);
	}

	/** Opens a web link in the browser (workbench.externalBrowser) once confirmed. */
	async openLink(url: string, source: LinkSource) {
		if (!(await this.confirm(url, source))) return;
		await invoke('open_web_url', { url }).catch((e) => notifications.error(t('trust.link.failed', { error: String(e) })));
	}

	/** Editor links and the Manage Trusted Domains command. Returns the uninstaller. */
	install(): () => void {
		setEditorLinkHandler((url) => {
			void this.openLink(url, { fromWorkspace: true });
			return true;
		});
		const unregister = commands.register({ id: 'workbench.action.manageTrustedDomain', title: 'Manage Trusted Domains', run: () => this.manage() });
		return () => {
			setEditorLinkHandler(null);
			unregister();
		};
	}
}

export const trustedDomains = new TrustedDomains();
