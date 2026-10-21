// Profiles (VS Code: IUserDataProfilesService for settings and keybindings). Rust keeps each
// profile's settings.json and keybindings.json (user_profiles.rs); switching reloads both, like
// VS Code's profile switch in the window. Each window has its own profile (the folder remembers
// the one switched to; Rust resolves it). Commands: Switch Profile…, New Profile… (empty, a copy
// or a template), New Window with Profile…, New Temporary Profile, Rename…, Delete…, Export…,
// Import….

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { keybindings } from '#lib/workbench/keybindings.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { open, save } from '@tauri-apps/plugin-dialog';
import { activeProfileName, DEFAULT_PROFILE_NAME, templateContents, type Profile, type ProfileList, type TemplateSummary } from './profiles';
import { PROFILE_TEMPLATES, templateSettingsText, temporaryProfileName } from './profileTemplates';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { settings } from './settings.svelte';

/** Quick pick id of the Default profile (Rust's `None`). */
const DEFAULT_ID = '\0default';

class Profiles {
	list = $state.raw<ProfileList>({ active: null, profiles: [] });
	/** `${profileName}`: empty for Default. */
	readonly name: string = $derived(activeProfileName(this.list));

	async load() {
		this.list = await invoke<ProfileList>('profiles_list').catch(() => this.list);
	}

	#fail(e: unknown) {
		notifications.error(t('profiles.failed', { error: String(e) }));
	}

	/** Every profile for a picker, Default first, the active one marked. */
	#items(include: (p: Profile | null) => boolean): PickItem[] {
		const all: (Profile | null)[] = [null, ...this.list.profiles];
		return all.filter(include).map((p) => ({
			id: p?.id ?? DEFAULT_ID,
			label: p?.name ?? t('profiles.default'),
			description: [(p?.id ?? null) === this.list.active && t('profiles.current'), p?.transient && t('profiles.temporary')].filter(Boolean).join(' · ') || undefined
		}));
	}

	async switchTo(id: string | null) {
		try {
			this.list = await invoke<ProfileList>('profile_switch', { id });
		} catch (e) {
			return this.#fail(e);
		}
		await Promise.all([settings.load(), keybindings.load()]);
		status.flash(t('profiles.switched', { name: this.name || t('profiles.default') }), 3000);
	}

	async pickSwitch() {
		await this.load();
		const item = await quick.choose({ placeholder: t('profiles.switchPlaceholder'), items: this.#items(() => true) });
		if (!item) return;
		const id = item.id === DEFAULT_ID ? null : item.id;
		if (id !== this.list.active) await this.switchTo(id);
	}

	/** New Profile…: a name, then what to copy (an empty profile, Default or another), then switch to it. */
	async create() {
		await this.load();
		const name = await quick.input({ placeholder: t('profiles.newPlaceholder'), hint: (v) => (v.trim() ? t('profiles.newHint', { name: v.trim() }) : t('profiles.nameHint')) });
		if (!name?.trim()) return;
		const EMPTY = '\0empty';
		const TEMPLATE = '\0template:';
		const profilesItems = this.#items((p) => !p?.transient);
		const from = await quick.choose({
			placeholder: t('profiles.copyFromPlaceholder'),
			items: [
				{ id: EMPTY, label: t('profiles.empty') },
				...profilesItems.map((it, i) => (i === 0 ? { ...it, separator: t('profiles.profilesGroup') } : it)),
				...PROFILE_TEMPLATES.map((tpl, i) => ({ id: TEMPLATE + tpl.id, label: tpl.name, separator: i === 0 ? t('profiles.templates') : undefined }))
			]
		});
		if (!from) return;
		const template = from.id.startsWith(TEMPLATE) ? PROFILE_TEMPLATES.find((tpl) => TEMPLATE + tpl.id === from.id) : undefined;
		let profile: Profile;
		try {
			profile = await invoke<Profile>('profile_create', {
				name,
				copyFrom: template || from.id === EMPTY ? null : from.id === DEFAULT_ID ? '' : from.id,
				settings: template ? templateSettingsText(template) : null
			});
		} catch (e) {
			return this.#fail(e);
		}
		await this.switchTo(profile.id);
	}

	/** New Window with Profile…: a new empty window that uses the profile picked. */
	async newWindowWithProfile() {
		await this.load();
		const item = await quick.choose({ placeholder: t('profiles.newWindowPlaceholder'), items: this.#items((p) => !p?.transient) });
		if (!item) return;
		await workspace.newWindow({ profile: item.id === DEFAULT_ID ? '' : item.id });
	}

	/** New Temporary Profile: an empty profile for this window only, deleted when it closes. */
	async createTemporary() {
		await this.load();
		let profile: Profile;
		try {
			profile = await invoke<Profile>('profile_create', { name: temporaryProfileName(this.list.profiles.map((p) => p.name)), copyFrom: null, transient: true });
		} catch (e) {
			return this.#fail(e);
		}
		await this.switchTo(profile.id);
		notifications.info(t('profiles.temporaryCreated', { name: profile.name }));
	}

	async rename() {
		await this.load();
		const others = this.list.profiles;
		if (!others.length) return notifications.info(t('profiles.noOthers'));
		const target = this.list.active ? others.find((p) => p.id === this.list.active) : await this.#pickOther(t('profiles.switchPlaceholder'));
		if (!target) return;
		const name = await quick.input({ placeholder: t('profiles.renamePlaceholder', { name: target.name }), value: target.name, hint: (v) => (v.trim() ? t('profiles.renameHint', { name: v.trim() }) : t('profiles.nameHint')) });
		if (!name?.trim() || name.trim() === target.name) return;
		try {
			this.list = await invoke<ProfileList>('profile_rename', { id: target.id, name });
		} catch (e) {
			this.#fail(e);
		}
	}

	async remove() {
		await this.load();
		if (!this.list.profiles.length) return notifications.info(t('profiles.noOthers'));
		const target = await this.#pickOther(t('profiles.deletePlaceholder'));
		if (!target || !(await ask(t('profiles.deleteConfirm', { name: target.name }), { kind: 'warning', okLabel: t('profiles.delete') }))) return;
		const wasActive = target.id === this.list.active;
		try {
			this.list = await invoke<ProfileList>('profile_delete', { id: target.id });
		} catch (e) {
			return this.#fail(e);
		}
		// Deleting the active profile switches to Default (Rust already did).
		if (wasActive) await Promise.all([settings.load(), keybindings.load()]);
	}

	/** Export Profile…: the active profile (or one picked when there are others), to a `.code-profile` file. */
	async exportProfile() {
		await this.load();
		const item = this.list.profiles.length ? await quick.choose({ placeholder: t('profiles.exportPlaceholder'), items: this.#items(() => true) }) : { id: DEFAULT_ID };
		if (!item) return;
		const id = item.id === DEFAULT_ID ? null : item.id;
		const name = this.list.profiles.find((p) => p.id === id)?.name ?? DEFAULT_PROFILE_NAME;
		const path = await save({ title: t('profiles.exportTitle'), defaultPath: `${name}.code-profile`, filters: [{ name: t('profiles.fileFilter'), extensions: ['code-profile'] }] }).catch(() => null);
		if (!path) return;
		try {
			await invoke('profile_export', { id, path });
		} catch (e) {
			return this.#fail(e);
		}
		notifications.info(t('profiles.exported', { name, path }));
	}

	/** Import Profile…: a `.code-profile` file (Kingu's or VS Code's), a name, then switch to it. */
	async importProfile() {
		const picked = await open({ title: t('profiles.importTitle'), multiple: false, directory: false, filters: [{ name: t('profiles.fileFilter'), extensions: ['code-profile', 'json'] }] }).catch(() => null);
		const path = typeof picked === 'string' ? picked : null;
		if (!path) return;
		let summary: TemplateSummary;
		try {
			summary = await invoke<TemplateSummary>('profile_import_preview', { path });
		} catch (e) {
			return this.#fail(e);
		}
		await this.load();
		const taken = (v: string) => v.trim().toLowerCase() === DEFAULT_PROFILE_NAME.toLowerCase() || this.list.profiles.some((p) => p.name.toLowerCase() === v.trim().toLowerCase());
		const contents = templateContents(summary).map((c) => (c.key === 'profiles.partSnippets' ? t(c.key, { count: c.count }) : t(c.key))).join(', ') || t('profiles.importNothing');
		const name = await quick.input({
			placeholder: t('profiles.importPlaceholder'),
			value: summary.name && !taken(summary.name) ? summary.name : '',
			hint: (v) => (!v.trim() ? t('profiles.nameHint') : taken(v) ? t('profiles.nameTaken', { name: v.trim() }) : t('profiles.importHint', { name: v.trim(), contents }))
		});
		if (!name?.trim() || taken(name)) return;
		let profile: Profile;
		try {
			profile = await invoke<Profile>('profile_import', { path, name });
		} catch (e) {
			return this.#fail(e);
		}
		await this.switchTo(profile.id);
	}

	async #pickOther(placeholder: string): Promise<Profile | undefined> {
		const item = await quick.choose({ placeholder, items: this.#items((p) => p !== null) });
		return this.list.profiles.find((p) => p.id === item?.id);
	}

	install(): () => void {
		void this.load();
		// The list changed outside (another Kingu, a hand edit): settings and keybindings follow.
		const unlisten = listen<string>('settings://changed', (e) => e.payload === 'profiles' && void this.load());
		const unregister = [
			commands.register({ id: 'workbench.profiles.actions.switchProfile', title: 'Switch Profile...', category: 'Profiles', run: () => this.pickSwitch() }),
			commands.register({ id: 'workbench.profiles.actions.createProfile', title: 'New Profile...', category: 'Profiles', run: () => this.create() }),
			commands.register({ id: 'workbench.profiles.actions.newWindowWithProfile', title: 'New Window with Profile...', category: 'Profiles', run: () => this.newWindowWithProfile() }),
			commands.register({ id: 'workbench.profiles.actions.createTemporaryProfile', title: 'New Temporary Profile', category: 'Profiles', run: () => this.createTemporary() }),
			commands.register({ id: 'workbench.profiles.actions.renameProfile', title: 'Rename Profile...', category: 'Profiles', run: () => this.rename() }),
			commands.register({ id: 'workbench.profiles.actions.deleteProfile', title: 'Delete Profile...', category: 'Profiles', run: () => this.remove() }),
			commands.register({ id: 'workbench.profiles.actions.exportProfile', title: 'Export Profile...', category: 'Profiles', run: () => this.exportProfile() }),
			commands.register({ id: 'workbench.profiles.actions.importProfile', title: 'Import Profile...', category: 'Profiles', run: () => this.importProfile() })
		];
		return () => {
			void unlisten.then((u) => u());
			unregister.forEach((u) => u());
		};
	}
}

export const profiles = new Profiles();
