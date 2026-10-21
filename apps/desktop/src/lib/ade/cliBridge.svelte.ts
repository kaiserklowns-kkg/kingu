// The window's side of the `kingu` command (Rust cli_server.rs, crates/kingu-cli): `task create`,
// `task open`, `open` and `editor.open` (`kingu [options] [paths…]`, VS Code's `code`) arrive as
// `kingu-cli:request` events (a window the command just opened fetches them with `cli_queued`)
// and are answered with `cli_reply` (the command waits for it); `--wait` is reported with
// `cli_wait_done` once its editors are closed. Also the palette's "Shell Command: Install 'kingu'
// command in PATH" / "Uninstall …" (VS Code's `code` install), and the `kingu` skill handed to
// agents with the Snap skills (mcp.ts).

import { invoke } from '@tauri-apps/api/core';
import { listenWindow } from '#lib/workbench/windowEvents.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { compareKey } from '#lib/workbench/compare.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { ask, message } from '#lib/workbench/messageBox.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { workspaceTrust } from '#lib/workbench/workspaceTrust.svelte.ts';
import { profiles } from '#lib/settings/profiles.svelte.ts';
import { DEFAULT_PROFILE_NAME } from '#lib/settings/profiles.ts';
import { t } from '#lib/i18n/index.ts';
import { dirOf, editorOpens, openTarget, profileFor, waitOver, type CliRequest, type CreateParams, type EditorParams, type OpenParams } from './cliBridge.ts';
import { setBuiltInPluginProvider } from './mcp.ts';
import { adeTasks } from './tasks.svelte.ts';

async function handle(req: CliRequest): Promise<unknown> {
	switch (req.method) {
		case 'task.create': {
			const p = req.params as CreateParams;
			if (!workspace.root) throw new Error(t('cli.noFolder'));
			const slug = await adeTasks.create({ title: p.title, prompt: p.prompt, base: p.base ?? '', mode: p.mode ?? undefined, open: p.open, dispatchedBy: p.dispatchedBy ?? undefined });
			if (!slug) throw new Error(t('cli.taskNotCreated'));
			return { slug };
		}
		case 'task.open': {
			const slug = String(req.params.slug ?? '');
			if (!appMode.isAgents) appMode.setMode('agents');
			adeTasks.openTask(slug);
			return null;
		}
		case 'open': {
			const p = req.params as OpenParams;
			const target = openTarget(workspace.root, p);
			if ('error' in target) throw new Error(target.error === 'noFolder' ? t('cli.noFolder') : t('cli.outsideFolder', { path: p.path }));
			if (target.kind === 'folder') {
				if (!(await workspace.openFolder(target.path))) throw new Error(t('cli.folderNotOpened', { path: target.path }));
				return null;
			}
			if (appMode.isAgents) appMode.setMode('workbench');
			if (target.line) editors.openAt(target.rel, target.line, target.column ?? 1, { preview: false });
			else editors.open(target.rel, { preview: false });
			return null;
		}
		case 'editor.open':
			await openEditors(req.params as EditorParams);
			return null;
		default:
			throw new Error(t('cli.unknownRequest', { method: req.method }));
	}
}

/** `kingu [options] [paths…]` in this window (Rust picked it and allowed its outside files). */
async function openEditors(p: EditorParams) {
	if (p.profile) {
		await profiles.load();
		const id = profileFor(profiles.list.profiles, p.profile, DEFAULT_PROFILE_NAME);
		if (id === undefined) throw new Error(t('cli.noProfile', { name: p.profile }));
		if (id !== profiles.list.active) await profiles.switchTo(id);
	}
	if (p.folderMode === 'open' && p.folders.length) {
		const opened = p.folders.length === 1 ? await workspace.openFolder(p.folders[0], { newWindow: false }) : await workspace.openFolders(p.folders, { newWindow: false });
		if (!opened) throw new Error(t('cli.folderNotOpened', { path: p.folders.join(', ') }));
	} else if (p.folderMode === 'add') await workspace.addFolderToWorkspace(p.folders);
	else if (p.folderMode === 'remove') for (const f of p.folders) await workspace.removeFolder(f);
	// security.workspace.trust.untrustedFiles: files from outside the trusted folders.
	const files = p.files.map((f) => f.path);
	const decision = await workspaceTrust.confirmFiles(files);
	if (decision === 'cancel') return;
	if (decision === 'newWindow') return void (await workspace.newWindow({ files }));
	const opens = editorOpens(p, (abs) => workspace.keyFor(abs));
	if (opens.length && appMode.isAgents) appMode.setMode('workbench');
	const keys: string[] = [];
	for (const o of opens) {
		if (o.kind === 'compare') {
			const key = compareKey({ kind: 'resource', key: o.left }, o.right);
			editors.open(key, { preview: false });
			keys.push(key);
		} else {
			if (o.line) editors.openAt(o.key, o.line, o.column ?? 1, { preview: false });
			else editors.open(o.key, { preview: false });
			keys.push(o.key);
		}
	}
	// `--wait` on files: over once each is closed. A folder alone waits for the window (Rust).
	if (p.waitId !== null && keys.length) watchClosed(p.waitId, keys);
}

/** Reports `cli_wait_done` once none of `keys` is open in any editor group. */
function watchClosed(id: number, keys: string[]) {
	const stop = $effect.root(() => {
		$effect(() => {
			if (!waitOver(keys, editors.openPaths())) return;
			void invoke('cli_wait_done', { id }).catch(() => {});
			queueMicrotask(stop);
		});
	});
}

async function reply(req: CliRequest) {
	try {
		const result = await handle(req);
		await invoke('cli_reply', { id: req.id, result: result ?? null, error: null });
	} catch (e) {
		await invoke('cli_reply', { id: req.id, result: null, error: e instanceof Error ? e.message : String(e) }).catch(() => {});
	}
}

async function installInPath() {
	if (!(await ask(t('cli.installAsk', { dir: '/usr/local/bin (~/.local/bin)' }), { okLabel: t('cli.installOk') }))) return;
	try {
		const r = await invoke<{ path: string; on_path: boolean }>('cli_install');
		// VS Code's "Shell command 'code' successfully installed in PATH." (with what it is for).
		await message(r.on_path ? t('cli.installedExplain', { path: r.path }) : t('cli.installedNotOnPath', { path: r.path, dir: dirOf(r.path) }), { title: t('cli.installTitle') });
	} catch (e) {
		notifications.error(t('cli.installFailed', { error: String(e) }));
	}
}

async function uninstallFromPath() {
	try {
		const removed = await invoke<string[]>('cli_uninstall');
		status.flash(removed.length ? t('cli.uninstalled', { paths: removed.join(', ') }) : t('cli.notInstalled'), 6000);
	} catch (e) {
		notifications.error(t('cli.uninstallFailed', { error: String(e) }));
	}
}

/** Workbench wiring: the request listener, the palette commands and the agents' `kingu` skill. */
export function installCliBridge(): () => void {
	const unlisten = listenWindow<CliRequest>('kingu-cli:request', (e) => void reply(e.payload));
	// A window the command opened: its requests wait in Rust until this page knows its folders.
	let gone = false;
	void (async () => {
		while (!workspace.ready && !gone) await new Promise((r) => setTimeout(r, 50));
		if (gone) return;
		for (const req of await invoke<CliRequest[]>('cli_queued').catch(() => [])) void reply(req);
	})();
	// Asked per run: the Skills view can turn the skill off (Rust then answers none).
	setBuiltInPluginProvider(() => invoke<string | null>('cli_skill_plugin').then((d) => (d ? [d] : []), () => []));
	const unregister = [
		commands.register({ id: 'kingu.cli.install', title: "Shell Command: Install 'kingu' command in PATH", run: installInPath }),
		commands.register({ id: 'kingu.cli.uninstall', title: "Shell Command: Uninstall 'kingu' command from PATH", run: uninstallFromPath })
	];
	return () => {
		gone = true;
		void unlisten.then((u) => u());
		setBuiltInPluginProvider(async () => []);
		unregister.forEach((u) => u());
	};
}
