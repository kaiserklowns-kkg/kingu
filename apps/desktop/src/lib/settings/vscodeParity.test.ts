/// <reference types="bun" />
// Every VS Code-keyed setting Kingu registers must exist in VS Code's schema with the same type,
// default and enum, so a VS Code settings.json means the same thing here. The fixture is extracted
// from the VS Code source by tools/vscode-settings (key → type, default, enum; macOS defaults).
import { describe, expect, test } from 'bun:test';
import fixture from './testdata/vscode-settings.json';
import { schemaTypes } from './jsonSchema';
import { SETTINGS, type SettingSchema } from './registry';

type Entry = { type: string | string[] | null; default: unknown; enum?: unknown[] };
const VSCODE = fixture as Record<string, Entry>;

/**
 * Deliberate differences from VS Code's default, each with the reason. Keep this short: a new
 * entry needs a reason a VS Code user would accept.
 */
export const DEFAULT_DEVIATIONS: Readonly<Record<string, string>> = {
	'editor.fontFamily': 'adds IBM Plex Sans Thai so Thai text renders in the editor',
	'workbench.colorTheme': "Kingu's theme ids (the reference checkout ships its own theme names)",
	'workbench.preferredDarkColorTheme': "Kingu's theme ids (the reference checkout ships its own theme names)",
	'workbench.preferredLightColorTheme': "Kingu's theme ids (the reference checkout ships its own theme names)",
	'window.title': "VS Code's default is per platform; the fixture holds the macOS one and Kingu's tests run as Linux, which gets VS Code's Windows/Linux default",
	'workbench.startupEditor': 'Kingu has no Welcome page, so nothing opens by default',
	'workbench.editor.autoLockGroups': "VS Code builds the default from the editors registered at runtime (terminal, browser and process explorer editors lock); Kingu lists its own editor types, none of which locks",
	'js/ts.preferences.autoImportFileExcludePatterns': 'VS Code registers no default (unset reads as an empty list); every Kingu setting needs one',
	'js/ts.preferences.autoImportSpecifierExcludeRegexes': 'VS Code registers no default (unset reads as an empty list); every Kingu setting needs one',
	'typescript.preferences.autoImportFileExcludePatterns': 'VS Code registers no default (unset reads as an empty list); every Kingu setting needs one',
	'typescript.preferences.autoImportSpecifierExcludeRegexes': 'VS Code registers no default (unset reads as an empty list); every Kingu setting needs one',
	'json.schemas': 'VS Code registers no default (unset reads as an empty list); every Kingu setting needs one',
	'workbench.editorLargeFileConfirmation':"VS Code's 10 MB for remote and web windows (every byte crosses the webview IPC here); the local 1024 MB would load huge files into the webview without asking"
};

/**
 * Enum values VS Code has that Kingu leaves out, because the feature behind them does not exist
 * in Kingu (each with the reason). A value from a VS Code settings.json that is left out falls back
 * to the default, like any invalid value.
 */
export const ENUM_SUBSETS: Readonly<Record<string, string>> = {
	'workbench.startupEditor': 'no Welcome page or agent sessions page (welcomePage, welcomePageInEmptyWorkbench, agentSessionsWelcomePage)',
	'files.encoding': "the DOS code pages (cp437, cp850, cp852, cp857, cp865, cp1125) and KOI8-T, which the Rust decoder (encoding_rs) does not implement",
	'window.confirmBeforeClose': 'keyboardOnly needs to tell ⌘Q/⌘W from a menu click, and Tauri reports both as the same native menu event'
};

/** Kingu settings with a VS Code key that VS Code no longer registers (kept for older settings.json files). */
export const LEGACY_KEYS: Readonly<Record<string, string>> = {
	'terminal.integrated.shell.osx': 'VS Code replaced it with terminal profiles; Kingu still uses it when terminal.integrated.defaultProfile.* names no profile',
	'terminal.integrated.shell.linux': 'VS Code replaced it with terminal profiles; Kingu still uses it when terminal.integrated.defaultProfile.* names no profile',
	'terminal.integrated.shellArgs.osx': 'VS Code replaced it with terminal profiles; Kingu still uses it when terminal.integrated.defaultProfile.* names no profile',
	'terminal.integrated.shellArgs.linux': 'VS Code replaced it with terminal profiles; Kingu still uses it when terminal.integrated.defaultProfile.* names no profile',
	'workbench.panel.alignment': 'VS Code dropped it for workbench.panel.defaultLocation and the layout commands; Kingu still aligns the bottom panel with it'
};

/** The JSON-schema type(s) a Kingu schema accepts at the top level. */
function kinguTypes(s: SettingSchema): string[] | null {
	switch (s.type) {
		case 'number':
			return s.integer ? ['integer', 'number'] : ['number', 'integer'];
		case 'json':
			return schemaTypes(s.schema);
		default:
			return [s.type];
	}
}

function sameType(s: SettingSchema, v: Entry): boolean {
	const ours = kinguTypes(s);
	if (v.type === null || ours === null) return v.type === null && ours === null;
	if (typeof v.type === 'string') return s.type === 'json' ? ours.length === 1 && (ours[0] === v.type || (ours[0] === 'integer' && v.type === 'number')) : ours.includes(v.type);
	return s.type === 'json' && JSON.stringify(ours) === JSON.stringify(v.type);
}

/** A schema's enum: a string enum, a json schema's top-level enum, or an array's item enum. */
function enumOf(s: SettingSchema): readonly unknown[] | undefined {
	if (s.type === 'string') return s.enum;
	if (s.type === 'json') return s.schema.enum;
	return undefined;
}

const vscodeKeyed = SETTINGS.filter((s) => !s.id.startsWith('kingu.'));

describe('VS Code settings parity', () => {
	test('every non-kingu.* setting exists in VS Code with the same type and default', () => {
		const problems: string[] = [];
		for (const s of vscodeKeyed) {
			if (LEGACY_KEYS[s.id]) continue;
			const v = VSCODE[s.id];
			if (!v) {
				problems.push(`${s.id}: not a VS Code setting`);
				continue;
			}
			if (!sameType(s, v)) problems.push(`${s.id}: type ${JSON.stringify(kinguTypes(s))} vs VS Code ${JSON.stringify(v.type)}`);
			if (!DEFAULT_DEVIATIONS[s.id] && JSON.stringify(s.default) !== JSON.stringify(v.default))
				problems.push(`${s.id}: default ${JSON.stringify(s.default)} vs VS Code ${JSON.stringify(v.default)}`);
		}
		expect(problems).toEqual([]);
	});

	test('enums are VS Code’s, in its order (or a listed subset)', () => {
		const problems: string[] = [];
		for (const s of vscodeKeyed) {
			const ours = enumOf(s);
			const theirs = VSCODE[s.id]?.enum;
			// Theme pickers list the installed themes (VS Code's icon theme enum is only `null` without them).
			if (!theirs || !ours || /ColorTheme$/.test(s.id) || s.id === 'workbench.iconTheme') continue;
			if (ENUM_SUBSETS[s.id]) {
				if (!ours.every((v) => theirs.includes(v))) problems.push(`${s.id}: ${JSON.stringify(ours)} is not a subset of ${JSON.stringify(theirs)}`);
			} else if (JSON.stringify(ours) !== JSON.stringify(theirs)) problems.push(`${s.id}: ${JSON.stringify(ours)} vs VS Code ${JSON.stringify(theirs)}`);
		}
		expect(problems).toEqual([]);
	});

	test('deviations, enum subsets and legacy keys are real and still needed', () => {
		for (const id of Object.keys(DEFAULT_DEVIATIONS)) {
			const s = SETTINGS.find((x) => x.id === id);
			expect([id, s !== undefined && JSON.stringify(s.default) !== JSON.stringify(VSCODE[id]?.default)]).toEqual([id, true]);
		}
		for (const id of Object.keys(ENUM_SUBSETS)) {
			const s = SETTINGS.find((x) => x.id === id);
			const ours = s && enumOf(s);
			expect([id, !!ours && ours.length < (VSCODE[id]?.enum?.length ?? 0)]).toEqual([id, true]);
		}
		for (const id of Object.keys(LEGACY_KEYS)) expect([id, VSCODE[id] === undefined && SETTINGS.some((x) => x.id === id)]).toEqual([id, true]);
	});
});
