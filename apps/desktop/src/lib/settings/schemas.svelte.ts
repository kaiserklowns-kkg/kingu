// The settings schemas in effect: the static registry plus schemas contributed at runtime (each
// Snap's settings, as `snap.<snapId>.<key>`). The settings service resolves values against
// `all`, so a contributed setting is read with the usual `settings.get(id)`.

import { SETTINGS, settingsSections, type SettingSchema } from './registry';

const FIXED = new Set(SETTINGS.map((s) => s.id));

class SettingSchemas {
	#contributed = $state<Record<string, SettingSchema[]>>({});
	readonly all: SettingSchema[] = $derived([...SETTINGS, ...Object.values(this.#contributed).flat()]);
	readonly byId: Map<string, SettingSchema> = $derived(new Map(this.all.map((s) => [s.id, s])));
	readonly sections = $derived(settingsSections(this.all));

	/** Replaces what `owner` contributes (an empty list removes it). Static ids are never replaced. */
	contribute(owner: string, list: SettingSchema[]) {
		this.#contributed = { ...this.#contributed, [owner]: list.filter((s) => !FIXED.has(s.id)) };
	}
}

export const settingSchemas = new SettingSchemas();
