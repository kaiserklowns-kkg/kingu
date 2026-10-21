// Workspace Trust for this window (VS Code's IWorkspaceTrustManagementService and its startup
// prompt, Restricted Mode banner and status item, Workspaces: Manage Workspace Trust). The trusted
// folders live in Rust (workspace_trust.rs, shared by every window); the rules are in
// workspaceTrust.ts. In Restricted Mode: tasks, automatic tasks and debugging ask for trust first
// (`request`), restricted settings of the folders do not apply (settings.trusted), and Rust starts
// no language server from the folders' node_modules.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { commands } from './commands.svelte';
import { choose } from './messageBox';
import { notifications } from './notifications.svelte';
import { workspace } from './workspace.svelte';
import { addTrusted, parentOf, removeTrusted, resolveTrust, shouldPrompt, showBanner, trustedBy, trustSettings, untrustedFilesAction, type TrustState } from './workspaceTrust';

type TrustData = { folders: string[]; prompted: string[] };

const DISMISSED_KEY = 'kingu.trust.bannerDismissed';

function loadDismissed(): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

class WorkspaceTrust {
	/** Trusted folders and workspace files (Rust's list, every window's). */
	list = $state.raw<string[]>([]);
	/** Workspaces the startup prompt was shown for. */
	prompted = $state.raw<string[]>([]);
	loaded = $state(false);
	/** An empty window's trust picked in the editor (this session only, like VS Code). */
	emptyOverride = $state<boolean | null>(null);
	/** The Workspace Trust editor is open. */
	managing = $state(false);
	#dismissed = $state.raw<string[]>(loadDismissed());
	/** Untrusted files were let into this workspace (`untrustedFiles: prompt` asks once per workspace). */
	#acceptedFiles = new Set<string>();

	readonly settings = $derived(trustSettings((id) => settings.userValue(id)));
	readonly folders: string[] = $derived(workspace.folders.map((f) => f.path));
	readonly state: TrustState = $derived(resolveTrust({ settings: this.settings, folders: this.folders, workspaceFile: workspace.workspaceFile, trusted: this.list, emptyOverride: this.emptyOverride }));
	/** Trusted now (folders count as untrusted until the list is read). */
	readonly trusted: boolean = $derived(this.state.disabled || this.state.empty ? this.state.trusted : this.loaded && this.state.trusted);
	/** Restricted Mode, once known (no banner or status item before the list is read). */
	readonly restricted: boolean = $derived(!this.trusted && (this.loaded || this.state.empty));
	/** The workspace's key for the banner and the startup prompt. */
	readonly #key: string = $derived(workspace.identity ?? workspace.stateKey ?? '');
	readonly bannerVisible: boolean = $derived(this.restricted && showBanner(this.settings, this.state, this.#dismissed.includes(this.#key)));

	async load() {
		try {
			const d = await invoke<TrustData>('workspace_trust_read');
			this.list = d.folders;
			this.prompted = d.prompted;
		} catch (e) {
			clientLog('error', `workspace trust: ${e}`);
		} finally {
			this.loaded = true;
		}
	}

	async #setList(list: string[]): Promise<boolean> {
		try {
			const d = await invoke<TrustData>('workspace_trust_set', { folders: list });
			this.list = d.folders;
			return true;
		} catch (e) {
			notifications.error(t('trust.failed', { error: String(e) }));
			return false;
		}
	}

	/** Trusts this window: its folders and its workspace file (an empty window for this session). */
	async trust(): Promise<boolean> {
		if (this.state.empty) {
			this.emptyOverride = true;
			return true;
		}
		// The folders (and workspace file) not trusted yet; one under a trusted parent needs nothing.
		return this.#setList(addTrusted(this.list, this.state.untrusted));
	}

	/** Trusts the folder above the (first) folder, and so everything beside it. */
	trustParent(): Promise<boolean> {
		return this.#setList(addTrusted(this.list, [this.parent]));
	}

	/** The folder "Trust Parent" trusts. */
	get parent(): string {
		return parentOf(this.folders[0] ?? '/');
	}

	/** Don't Trust: the window's own entries go (a trusted parent keeps it trusted). */
	async untrust(): Promise<boolean> {
		if (this.state.empty) {
			this.emptyOverride = false;
			return true;
		}
		return this.#setList(removeTrusted(this.list, workspace.workspaceFile ? [...this.folders, workspace.workspaceFile] : this.folders));
	}

	addFolder(path: string): Promise<boolean> {
		return this.#setList(addTrusted(this.list, [path]));
	}

	removeFolder(path: string): Promise<boolean> {
		return this.#setList(removeTrusted(this.list, [path]));
	}

	/** The editor's Add Folder: a folder picker. */
	async pickFolder() {
		const picked = await open({ directory: true, multiple: true, title: t('trust.editor.addTitle'), defaultPath: workspace.root ?? (workspace.home || undefined) });
		const dirs = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
		if (dirs.length) await this.#setList(addTrusted(this.list, dirs));
	}

	manage() {
		this.managing = true;
	}

	dismissBanner() {
		if (!this.#key || this.#dismissed.includes(this.#key)) return;
		this.#dismissed = [...this.#dismissed, this.#key].slice(-500);
		try {
			localStorage.setItem(DISMISSED_KEY, JSON.stringify(this.#dismissed));
		} catch {
			// Storage unavailable: dismissed until the window reloads.
		}
	}

	/**
	 * VS Code's requestWorkspaceTrust: true when trusted, else asks (`feature` is what needs it).
	 * Manage opens the editor and answers false.
	 */
	async request(feature: string): Promise<boolean> {
		if (!this.loaded && !this.state.empty) await this.load();
		if (this.trusted) return true;
		const trust = t('trust.request.trust');
		const manage = t('trust.request.manage');
		const answer = await choose(t('trust.request.message', { feature }), { title: t('trust.prompt.title'), kind: 'warning', buttons: [trust, manage, t('common.cancel')], cancelId: 2 });
		if (answer === manage) this.manage();
		return answer === trust && (await this.trust()) && this.trusted;
	}

	/** The startup prompt (`security.workspace.trust.startupPrompt`). */
	async #startupPrompt() {
		const key = this.#key;
		if (key) void invoke('workspace_trust_prompted', { identity: key }).then(() => (this.prompted = [...this.prompted, key]), () => {});
		const yes = t('trust.prompt.trust');
		const parent = t('trust.prompt.trustParent', { parent: this.parent.split('/').pop() || this.parent });
		const no = t('trust.prompt.dontTrust');
		const several = this.folders.length > 1 || workspace.workspaceFile !== null;
		const message = `${several ? t('trust.prompt.messageWorkspace') : t('trust.prompt.message')}\n\n${t('trust.prompt.detail')}`;
		const buttons = several ? [yes, no] : [yes, parent, no];
		const answer = await choose(message, { title: t('trust.prompt.title'), kind: 'warning', buttons, cancelId: buttons.length - 1 });
		if (answer === yes) await this.trust();
		else if (answer === parent) await this.trustParent();
	}

	/**
	 * Before files from outside the trusted folders open in this trusted window
	 * (`security.workspace.trust.untrustedFiles`): `open`, `newWindow` (open them in a new window
	 * instead) or `cancel`.
	 */
	async confirmFiles(files: readonly string[]): Promise<'open' | 'newWindow' | 'cancel'> {
		if (!files.length) return 'open';
		if (!this.loaded && !this.state.empty) await this.load();
		const action = untrustedFilesAction(this.settings, this.state, files, [...this.list, ...(this.state.empty ? [] : this.folders)], this.#acceptedFiles.has(this.#key));
		if (action !== 'prompt') return action;
		const outside = files.filter((f) => trustedBy(f, [...this.list, ...this.folders]) === null);
		const openHere = t('trust.untrustedFiles.open');
		const restricted = t('trust.untrustedFiles.newWindow');
		const answer = await choose(`${t('trust.untrustedFiles.message')}\n\n${t('trust.untrustedFiles.detail', { files: outside.map((f) => f.split('/').pop()).join(', ') })}`, {
			title: t('trust.prompt.title'),
			kind: 'warning',
			buttons: [openHere, restricted, t('common.cancel')],
			cancelId: 2
		});
		if (answer === openHere) {
			this.#acceptedFiles.add(this.#key);
			return 'open';
		}
		return answer === restricted ? 'newWindow' : 'cancel';
	}

	/** Reads the list, follows other windows' changes, keeps settings and language servers in step,
	 * and asks at startup per `startupPrompt`. Returns the uninstaller. */
	install(): () => void {
		void this.load();
		const unlisten = listen('workspace-trust://changed', () => void this.load());
		let asked = '';
		let lastTrusted: boolean | null = null;
		const stopEffects = $effect.root(() => {
			$effect(() => {
				settings.trusted = this.trusted;
			});
			// Trust changed in this workspace: language servers look for their binary again (a
			// folder's node_modules counts only when trusted) and automatic tasks get their turn.
			$effect(() => {
				const now = this.trusted;
				const key = this.#key;
				if (!workspace.ready || !this.loaded) return;
				const changed = lastTrusted !== null && lastTrusted !== now && asked === key;
				lastTrusted = now;
				if (!changed) return;
				void import('#lib/lsp/lsp.svelte.ts').then(({ lsp }) => lsp.restartAll());
				if (now) void import('#lib/tasks/tasks.svelte.ts').then(({ tasks }) => tasks.runAutomatic());
			});
			// A new workspace in this window: the startup prompt, per its setting.
			$effect(() => {
				const key = this.#key;
				if (!workspace.ready || !this.loaded || !key || key === asked) return;
				asked = key;
				lastTrusted = this.trusted;
				if (shouldPrompt(this.settings, this.state, this.prompted.includes(key))) void this.#startupPrompt();
			});
		});
		const unregister = [
			commands.register({ id: 'workbench.trust.manage', title: 'Manage Workspace Trust', category: 'Workspaces', run: () => this.manage() }),
			commands.register({ id: 'workbench.trust.configure', title: 'Configure Workspace Trust Settings', category: 'Workspaces', run: () => systemSettings.show('Security') })
		];
		return () => {
			stopEffects();
			void unlisten.then((u) => u());
			unregister.forEach((u) => u());
		};
	}
}

export const workspaceTrust = new WorkspaceTrust();
