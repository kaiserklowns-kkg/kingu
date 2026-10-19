// Skills store (Settings › Skills, skills/SkillsPage.svelte): every skill agents can get from
// `skill_hub_list` (Kingu-managed, Snap, built-in, the folder's and the user's .claude/skills),
// the on/off switch Rust keeps, installing from a link or a .skill file through a review of the
// staged files, Update / Remove, sharing (a link that installs it, an exported .skill file, or the
// team's shared skills on the team server) and the plugin folder agent runs get
// (ade/mcp.ts `setHubPluginProvider`). Nothing from a skill runs here.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { setHubPluginProvider } from '#lib/ade/mcp.ts';
import { t } from '#lib/i18n/index.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { team } from '#lib/team/team.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { ask, message } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { firstCandidate, looksInstallable, type PreparedSkills, type SkillInfo, type TeamSkill, type TeamSkills } from './skillModel.ts';

/** A staged install the page is showing for review. */
export type Review = { prepared: PreparedSkills; rel: string; mode: 'install' | 'update' | 'team' };

class Skills {
	list = $state<SkillInfo[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);
	/** Fetching a link (or an update) right now. */
	busy = $state<string | null>(null);
	review = $state<Review | null>(null);
	/** The skill whose SKILL.md is shown, and its text. */
	previewId = $state<string | null>(null);
	previewText = $state('');
	team = $state<TeamSkills | null>(null);
	teamError = $state<string | null>(null);
	#seq = 0;

	async load() {
		const seq = ++this.#seq;
		this.loading = true;
		try {
			const list = await invoke<SkillInfo[]>('skill_hub_list');
			if (seq !== this.#seq) return;
			this.list = list;
			this.error = null;
		} catch (e) {
			if (seq === this.#seq) this.error = String(e);
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	async setEnabled(s: SkillInfo, enabled: boolean) {
		try {
			await invoke('skill_hub_set_enabled', { id: s.id, enabled });
			status.flash(t(enabled ? 'skills.turnedOn' : 'skills.turnedOff', { name: s.name }));
		} catch (e) {
			notifications.error(t('skills.saveFailed', { error: String(e) }));
		}
		await this.load();
	}

	/** Skills: Install from Link… */
	async installFromLink(link?: string) {
		const text = link ?? (await quick.input({ placeholder: t('skills.linkPlaceholder'), hint: (v) => (looksInstallable(v) ? t('skills.linkHint', { link: v.trim() }) : t('skills.linkHelp')) }));
		if (!text?.trim()) return;
		await this.#stage(t('skills.fetching', { link: text.trim() }), 'install', () => invoke<PreparedSkills>('skill_hub_prepare', { link: text.trim() }));
	}

	/** Skills: Install from File… — a .skill or .zip archive. */
	async installFromFile() {
		const path = await open({ title: t('skills.pickFile'), multiple: false, directory: false, filters: [{ name: t('skills.fileFilter'), extensions: ['skill', 'zip'] }] }).catch(() => null);
		if (typeof path !== 'string') return;
		await this.#stage(t('skills.fetching', { link: path }), 'install', () => invoke<PreparedSkills>('skill_hub_prepare', { link: path }));
	}

	/** Fetches the skill again from where it came from; an unchanged one needs no review. */
	async update(s: SkillInfo) {
		await this.#stage(t('skills.checking', { name: s.name }), 'update', () => invoke<PreparedSkills>('skill_hub_prepare_update', { name: s.name }), (p) => {
			if (p.candidates[0]?.hash !== s.origin?.hash) return false;
			status.flash(t('skills.upToDate', { name: s.name }));
			return true;
		});
	}

	async #stage(label: string, mode: Review['mode'], run: () => Promise<PreparedSkills>, done?: (p: PreparedSkills) => boolean) {
		if (this.busy) return;
		await this.cancelReview();
		this.busy = label;
		try {
			const prepared = await run();
			if (done?.(prepared)) return void invoke('skill_hub_cancel', { token: prepared.token }).catch(() => {});
			this.review = { prepared, rel: firstCandidate(prepared)?.rel ?? '', mode };
			systemSettings.showPage('skills');
		} catch (e) {
			await message(String(e), { title: t('skills.fetchFailedTitle'), kind: 'error' });
		} finally {
			this.busy = null;
		}
	}

	async cancelReview() {
		const r = this.review;
		this.review = null;
		if (r) await invoke('skill_hub_cancel', { token: r.prepared.token }).catch(() => {});
	}

	/** Installs the reviewed candidate (Rust refuses it if its files changed since the review). */
	async commitReview() {
		const r = this.review;
		const c = r?.prepared.candidates.find((x) => x.rel === r.rel);
		if (!r || !c || c.error) return;
		const replace = r.prepared.existing.includes(c.name);
		this.review = null;
		try {
			const name = await invoke<string>('skill_hub_commit', { token: r.prepared.token, rel: c.rel, hash: c.hash, replace });
			status.flash(t(replace ? 'skills.updated' : 'skills.installed', { name }));
		} catch (e) {
			await message(String(e), { title: t('skills.installFailedTitle'), kind: 'error' });
			void invoke('skill_hub_cancel', { token: r.prepared.token }).catch(() => {});
		}
		await this.load();
		if (r.mode === 'team') void this.loadTeam();
	}

	async remove(s: SkillInfo) {
		if (s.source !== 'managed') return;
		const sure = await ask(t('skills.removeAsk', { name: s.name, dir: s.dir ?? '' }), { title: t('skills.removeTitle'), kind: 'warning', okLabel: t('skills.remove'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		try {
			await invoke('skill_hub_remove', { name: s.name });
			status.flash(t('skills.removed', { name: s.name }));
		} catch (e) {
			notifications.error(t('skills.removeFailed', { error: String(e) }));
		}
		await this.load();
	}

	async reveal(s: SkillInfo) {
		try {
			await invoke('skill_hub_reveal', { id: s.id });
		} catch (e) {
			notifications.error(String(e));
		}
	}

	/** Shows (or hides) the skill's SKILL.md under its row. */
	async togglePreview(s: SkillInfo) {
		if (this.previewId === s.id) return void (this.previewId = null);
		try {
			this.previewText = await invoke<string>('skill_hub_read', { id: s.id });
			this.previewId = s.id;
		} catch (e) {
			notifications.error(String(e));
		}
	}

	/** Copies the link that installs this skill; a skill with no remote origin is exported instead. */
	async copyShareLink(s: SkillInfo) {
		if (s.shareLink) {
			try {
				await navigator.clipboard.writeText(s.shareLink);
				status.flash(t('skills.linkCopied', { link: s.shareLink }), 6000);
			} catch (e) {
				notifications.error(String(e));
			}
			return;
		}
		const sure = await ask(t('skills.noLinkAsk', { name: s.name }), { title: t('skills.noLinkTitle'), okLabel: t('skills.export'), cancelLabel: t('common.cancel') });
		if (sure) await this.exportSkill(s);
	}

	/** Saves the skill as a .skill archive (a zip of its folder) that Install from File reads. */
	async exportSkill(s: SkillInfo) {
		const dest = await save({ title: t('skills.exportTitle', { name: s.name }), defaultPath: `${s.name}.skill`, filters: [{ name: t('skills.fileFilter'), extensions: ['skill', 'zip'] }] }).catch(() => null);
		if (!dest) return;
		try {
			await invoke('skill_hub_export', { id: s.id, dest });
			status.flash(t('skills.exported', { path: dest }), 6000);
		} catch (e) {
			notifications.error(t('skills.exportFailed', { error: String(e) }));
		}
	}

	// ---- team -------------------------------------------------------------------

	async loadTeam() {
		const serverUrl = team.serverUrl;
		if (!serverUrl || !team.status?.signed_in) {
			this.team = null;
			this.teamError = null;
			return;
		}
		try {
			this.team = await invoke<TeamSkills>('team_skill_list', { serverUrl });
			this.teamError = null;
		} catch (e) {
			this.teamError = String(e);
		}
	}

	/** Shares an installed git skill with the team at its installed commit (Rust checks it can be fetched again). */
	async shareWithTeam(s: SkillInfo) {
		const note = await quick.input({ placeholder: t('skills.team.notePlaceholder', { name: s.name }), hint: (v) => (v.trim() ? t('skills.team.shareWithNote', { name: s.name }) : t('skills.team.shareNoNote', { name: s.name })) });
		if (note === undefined) return;
		this.busy = t('skills.team.sharing', { name: s.name });
		try {
			await invoke('team_skill_share', { serverUrl: team.serverUrl, name: s.name, note: note.trim() || null });
			status.flash(t('skills.team.shared', { name: s.name }));
		} catch (e) {
			await message(String(e), { title: t('skills.team.shareFailedTitle'), kind: 'error' });
		} finally {
			this.busy = null;
		}
		await this.loadTeam();
	}

	async unshare(entry: TeamSkill) {
		const sure = await ask(t('skills.team.unshareAsk', { name: entry.skill_name }), { title: t('skills.team.unshareTitle'), kind: 'warning', okLabel: t('skills.team.unshare'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		try {
			await invoke('team_skill_unshare', { serverUrl: team.serverUrl, name: entry.skill_name });
			status.flash(t('skills.team.unshared', { name: entry.skill_name }));
		} catch (e) {
			notifications.error(String(e));
		}
		await this.loadTeam();
	}

	/** Installs a team skill at its pinned commit; Rust refuses it unless its hash is the shared one. */
	async installTeam(entry: TeamSkill) {
		await this.#stage(t('skills.team.fetching', { name: entry.skill_name }), 'team', () => invoke<PreparedSkills>('team_skill_install', { serverUrl: team.serverUrl, name: entry.skill_name }));
	}
}

export const skills = new Skills();

/** Workbench wiring: agent runs get the enabled skills' plugin; palette commands; reloads. */
export function installSkills(): () => void {
	setHubPluginProvider(() => invoke<string[]>('skill_hub_plugins'));
	// Other tools can change ~/.claude/skills and the folder's .claude/skills: re-list on focus.
	const reload = () => void skills.load();
	window.addEventListener('focus', reload);
	const stopEffects = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(reload);
		});
		$effect(() => {
			void team.serverUrl;
			void team.status?.signed_in;
			untrack(() => void skills.loadTeam());
		});
	});
	const unregister = [
		commands.register({ id: 'kingu.skills.show', title: 'Show Skills', category: 'Skills', run: () => systemSettings.showPage('skills') }),
		commands.register({ id: 'kingu.skills.installFromLink', title: 'Install from Link…', category: 'Skills', run: () => skills.installFromLink() }),
		commands.register({ id: 'kingu.skills.installFromFile', title: 'Install from File…', category: 'Skills', run: () => skills.installFromFile() })
	];
	return () => {
		window.removeEventListener('focus', reload);
		stopEffects();
		unregister.forEach((u) => u());
		setHubPluginProvider(async () => []);
		void skills.cancelReview();
	};
}
