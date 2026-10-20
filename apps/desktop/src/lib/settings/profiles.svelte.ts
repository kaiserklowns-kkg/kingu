// Profiles (VS Code: IUserDataProfilesService for settings and keybindings). Rust keeps each
// profile's settings.json and keybindings.json (user_profiles.rs); switching reloads both, like
// VS Code's profile switch in the window. Commands: Profiles: Switch Profile…, New Profile…,
// Rename Profile…, Delete Profile….

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { keybindings } from '#lib/workbench/keybindings.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { activeProfileName, type Profile, type ProfileList } from './profiles';
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
			description: (p?.id ?? null) === this.list.active ? t('profiles.current') : undefined
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
		const from = await quick.choose({ placeholder: t('profiles.copyFromPlaceholder'), items: [{ id: EMPTY, label: t('profiles.empty') }, ...this.#items(() => true)] });
		if (!from) return;
		let profile: Profile;
		try {
			profile = await invoke<Profile>('profile_create', { name, copyFrom: from.id === EMPTY ? null : from.id === DEFAULT_ID ? '' : from.id });
		} catch (e) {
			return this.#fail(e);
		}
		await this.switchTo(profile.id);
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
			commands.register({ id: 'workbench.profiles.actions.renameProfile', title: 'Rename Profile...', category: 'Profiles', run: () => this.rename() }),
			commands.register({ id: 'workbench.profiles.actions.deleteProfile', title: 'Delete Profile...', category: 'Profiles', run: () => this.remove() })
		];
		return () => {
			void unlisten.then((u) => u());
			unregister.forEach((u) => u());
		};
	}
}

export const profiles = new Profiles();
