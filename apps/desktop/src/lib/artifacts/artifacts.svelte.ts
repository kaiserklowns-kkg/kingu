// Artifacts service: the open folder's artifacts (Rust artifacts_list, refreshed on the
// `artifacts://changed` event a publish or delete sends), teammates' shared artifacts on the team
// server, and the actions the side view, the viewer and the chat card share (open, export, share
// with team, delete). Pages are previewed in ArtifactViewer.svelte.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { team } from '#lib/team/team.svelte.ts';
import { theme } from '#lib/theme/theme.svelte.ts';
import { isDarkType } from '#lib/theme/themes.ts';
import { t } from '#lib/i18n/index.ts';
import { artifactKey, markdownPage, teamArtifactKey, type ArtifactFormat, type ArtifactMeta, type TeamArtifact } from './artifacts';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Artifacts {
	/** The open folder's artifacts, most recently updated first. */
	list = $state<ArtifactMeta[]>([]);
	/** The folder `list` belongs to. */
	loadedRoot = $state<string | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	team = $state<TeamArtifact[]>([]);
	teamLoading = $state(false);
	teamError = $state<string | null>(null);
	/** Bumped per artifact (`<root>:<id>`) on every change Rust reports: an open viewer reloads. */
	revisions = $state<Record<string, number>>({});
	/** The version a viewer opens with (the chat card's); else the latest. */
	#wanted = new Map<string, number>();

	get teamReady(): boolean {
		return !!team.serverUrl && !!team.status?.signed_in;
	}

	async load() {
		const root = workspace.root;
		if (!root) {
			this.list = [];
			this.loadedRoot = null;
			return;
		}
		this.loading = true;
		try {
			const list = await invoke<ArtifactMeta[]>('artifacts_list', { root });
			if (workspace.root !== root) return;
			this.list = list;
			this.loadedRoot = root;
			this.error = null;
		} catch (e) {
			this.error = message(e);
		} finally {
			this.loading = false;
		}
	}

	async loadTeam() {
		if (!this.teamReady) {
			this.team = [];
			return;
		}
		this.teamLoading = true;
		try {
			this.team = await invoke<TeamArtifact[]>('team_artifacts_list', { serverUrl: team.serverUrl });
			this.teamError = null;
		} catch (e) {
			this.teamError = message(e);
		} finally {
			this.teamLoading = false;
		}
	}

	revision(root: string, id: string): number {
		return this.revisions[`${root}:${id}`] ?? 0;
	}

	/** Opens a project artifact in an editor tab (the workbench's: the Agents layout has no editor for it). */
	open(root: string, id: string, version?: number, pinned = true) {
		if (appMode.isAgents) appMode.setMode('workbench');
		const key = artifactKey(root, id);
		if (version) this.#wanted.set(key, version);
		editors.open(key, { preview: !pinned });
	}

	openTeam(id: string, pinned = true) {
		if (appMode.isAgents) appMode.setMode('workbench');
		editors.open(teamArtifactKey(id), { preview: !pinned });
	}

	/** The version a viewer of `key` starts on (asked once), else null for the latest. */
	takeWanted(key: string): number | null {
		const v = this.#wanted.get(key) ?? null;
		this.#wanted.delete(key);
		return v;
	}

	/** The page Rust bundles, previews or shares: Markdown rendered here, HTML as stored (null). */
	async pageFor(root: string, id: string, version: number, format: ArtifactFormat, title: string): Promise<string | null> {
		if (format !== 'markdown') return null;
		const source = await invoke<string>('artifact_read_entry', { root, id, version });
		return markdownPage(source, title, isDarkType(theme.current.type));
	}

	async exportVersion(root: string, meta: ArtifactMeta, version: number) {
		const v = meta.versions.find((x) => x.version === version);
		if (!v) return;
		try {
			const html = await this.pageFor(root, meta.id, version, v.format, meta.title);
			const path = await invoke<string | null>('artifact_export', { root, id: meta.id, version, html });
			if (path) status.flash(t('artifacts.exported', { path }), 4000);
		} catch (e) {
			notifications.error(t('artifacts.exportFailed', { error: message(e) }));
		}
	}

	async share(root: string, meta: ArtifactMeta, version: number) {
		const v = meta.versions.find((x) => x.version === version);
		if (!v) return;
		if (!this.teamReady) {
			team.startSignIn();
			return;
		}
		const ok = await ask(t('artifacts.shareAsk', { title: meta.title, version }), { title: t('artifacts.share'), okLabel: t('artifacts.shareOk') });
		if (!ok) return;
		try {
			const html = await this.pageFor(root, meta.id, version, v.format, meta.title);
			await invoke('artifact_share_team', { serverUrl: team.serverUrl, root, id: meta.id, version, html });
			status.flash(t('artifacts.shared', { title: meta.title }), 4000);
			void this.loadTeam();
		} catch (e) {
			notifications.error(t('artifacts.shareFailed', { error: message(e) }));
		}
	}

	async remove(root: string, meta: ArtifactMeta) {
		const ok = await ask(t('artifacts.deleteAsk', { title: meta.title, count: meta.versions.length }), { kind: 'warning', okLabel: t('artifacts.delete') });
		if (!ok) return;
		try {
			await invoke('artifact_delete', { root, id: meta.id });
			editors.close(artifactKey(root, meta.id), { force: true });
		} catch (e) {
			notifications.error(t('artifacts.deleteFailed', { error: message(e) }));
		}
	}

	async removeShared(a: TeamArtifact) {
		const ok = await ask(t('artifacts.unshareAsk', { title: a.title }), { kind: 'warning', okLabel: t('artifacts.unshare') });
		if (!ok) return;
		try {
			await invoke('team_artifact_delete', { serverUrl: team.serverUrl, id: a.artifact_id });
			editors.close(teamArtifactKey(a.artifact_id), { force: true });
			void this.loadTeam();
		} catch (e) {
			notifications.error(t('artifacts.unshareFailed', { error: message(e) }));
		}
	}

	show() {
		if (appMode.isAgents) appMode.setMode('workbench');
		layout.sideView = 'artifacts';
		layout.sidebarVisible = true;
	}
}

export const artifacts = new Artifacts();

export function installArtifacts(): () => void {
	const unlisten = listen<{ root: string; id: string }>('artifacts://changed', (e) => {
		const k = `${e.payload.root}:${e.payload.id}`;
		artifacts.revisions = { ...artifacts.revisions, [k]: (artifacts.revisions[k] ?? 0) + 1 };
		if (e.payload.root === workspace.root) void artifacts.load();
	});
	const unregister = [
		commands.register({ id: 'kingu.artifacts.show', title: 'Show Artifacts', category: 'View', run: () => artifacts.show() }),
		commands.register({ id: 'kingu.artifacts.refresh', title: 'Refresh Artifacts', category: 'Artifacts', run: () => Promise.all([artifacts.load(), artifacts.loadTeam()]) })
	];
	return () => {
		void unlisten.then((u) => u());
		for (const u of unregister) u();
	};
}
