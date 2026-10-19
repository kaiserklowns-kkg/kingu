// The window's side of the `kingu` command (Rust cli_server.rs, crates/kingu-cli): `task create`,
// `task open` and `open` arrive as `kingu-cli:request` events and are answered with `cli_reply`
// (the command waits for it). Also the palette's "Shell Command: Install 'kingu' command in
// PATH" / "Uninstall …" (VS Code's `code` install), and the `kingu` skill handed to agents with
// the Snap skills (mcp.ts).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { dirOf, openTarget, type CliRequest, type CreateParams, type OpenParams } from './cliBridge.ts';
import { setBuiltInPluginProvider } from './mcp.ts';
import { adeTasks } from './tasks.svelte.ts';

async function handle(req: CliRequest): Promise<unknown> {
	switch (req.method) {
		case 'task.create': {
			const p = req.params as CreateParams;
			if (!workspace.root) throw new Error(t('cli.noFolder'));
			const slug = await adeTasks.create({ title: p.title, prompt: p.prompt, base: p.base ?? '', mode: p.mode ?? undefined, open: p.open });
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
		default:
			throw new Error(t('cli.unknownRequest', { method: req.method }));
	}
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
		if (r.on_path) status.flash(t('cli.installed', { path: r.path }), 8000);
		else notifications.info(t('cli.installedNotOnPath', { path: r.path, dir: dirOf(r.path) }));
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
	const unlisten = listen<CliRequest>('kingu-cli:request', (e) => void reply(e.payload));
	let plugin: Promise<string[]> | null = null;
	setBuiltInPluginProvider(() => (plugin ??= invoke<string | null>('cli_skill_plugin').then((d) => (d ? [d] : []), () => [])));
	const unregister = [
		commands.register({ id: 'kingu.cli.install', title: "Shell Command: Install 'kingu' command in PATH", run: installInPath }),
		commands.register({ id: 'kingu.cli.uninstall', title: "Shell Command: Uninstall 'kingu' command from PATH", run: uninstallFromPath })
	];
	return () => {
		void unlisten.then((u) => u());
		setBuiltInPluginProvider(async () => []);
		unregister.forEach((u) => u());
	};
}
