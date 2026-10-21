// The settings schemas in effect: the static registry plus schemas contributed at runtime (each
// Snap's settings, as `snap.<snapId>.<key>`). The settings service resolves values against
// `all`, so a contributed setting is read with the usual `settings.get(id)`.

import { SETTINGS, settingsSections, type SettingSchema } from './registry';
import { withEnumValues, type EnumExtra } from './enumValues.ts';

const FIXED = new Set(SETTINGS.map((s) => s.id));

class SettingSchemas {
	#contributed = $state<Record<string, SettingSchema[]>>({});
	/** Values contributed to static settings' enums (snap themes for `workbench.colorTheme`), by setting then owner. */
	#enums = $state<Record<string, Record<string, EnumExtra>>>({});
	readonly all: SettingSchema[] = $derived([
		...SETTINGS.map((s) => {
			const extra = this.#enums[s.id];
			if (!extra) return s;
			const merged = Object.values(extra);
			return withEnumValues(s, { values: merged.flatMap((e) => e.values), labels: merged.flatMap((e) => e.labels) });
		}),
		...Object.values(this.#contributed).flat()
	]);
	readonly byId: Map<string, SettingSchema> = $derived(new Map(this.all.map((s) => [s.id, s])));
	readonly sections = $derived(settingsSections(this.all));

	/** Replaces what `owner` contributes (an empty list removes it). Static ids are never replaced. */
	contribute(owner: string, list: SettingSchema[]) {
		this.#contributed = { ...this.#contributed, [owner]: list.filter((s) => !FIXED.has(s.id)) };
	}

	/** Replaces the values `owner` adds to the enum of static setting `id` (VS Code lists installed
	 * themes in `workbench.colorTheme`'s enum); `labels` are their descriptions. */
	extendEnum(owner: string, id: string, values: string[], labels: string[] = values) {
		const current = this.#enums[id]?.[owner];
		if (current && JSON.stringify(current) === JSON.stringify({ values, labels })) return;
		this.#enums = { ...this.#enums, [id]: { ...this.#enums[id], [owner]: { values, labels } } };
	}
}

export const settingSchemas = new SettingSchemas();
