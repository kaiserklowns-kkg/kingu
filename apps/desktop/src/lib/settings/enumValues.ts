// Values added at runtime to a static setting's enum (snaps' themes for `workbench.colorTheme` and
// `workbench.iconTheme`, as VS Code lists installed themes). Pure, for `bun test`.

import type { SettingSchema } from './registry';

export type EnumExtra = { values: string[]; labels: string[] };

/** `schema` with `extra` values added to its enum (a string setting's, or a JSON schema's `enum`). */
export function withEnumValues(schema: SettingSchema, extra: EnumExtra | undefined): SettingSchema {
	if (!extra?.values.length) return schema;
	if (schema.type === 'string' && schema.enum) {
		const values = extra.values.filter((v) => !schema.enum!.includes(v));
		const labels = extra.labels.filter((_, i) => !schema.enum!.includes(extra.values[i]));
		return { ...schema, enum: [...schema.enum, ...values], ...(schema.enumDescriptions ? { enumDescriptions: [...schema.enumDescriptions, ...labels] } : {}) };
	}
	if (schema.type === 'json' && Array.isArray(schema.schema.enum)) {
		const own = schema.schema.enum as unknown[];
		return { ...schema, schema: { ...schema.schema, enum: [...own, ...extra.values.filter((v) => !own.includes(v))] } };
	}
	return schema;
}
