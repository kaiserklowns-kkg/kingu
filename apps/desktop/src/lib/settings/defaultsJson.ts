// Default Settings (JSON) and Default Keyboard Shortcuts (JSON) (VS Code:
// `workbench.action.openRawDefaultSettings`, `workbench.action.openDefaultKeybindingsFile`):
// read-only documents generated from the settings registry and the command registry. Pure.

import type { SettingSchema } from './registry';

export const DEFAULT_SETTINGS_KEY = 'settings://defaults/settings.json';
export const DEFAULT_KEYBINDINGS_KEY = 'settings://defaults/keybindings.json';
export const isDefaultsKey = (key: string) => key === DEFAULT_SETTINGS_KEY || key === DEFAULT_KEYBINDINGS_KEY;

const comment = (text: string, indent: string) =>
	text
		.split('\n')
		.map((l) => l.trimEnd())
		.filter((l, i, all) => l || (i > 0 && i < all.length - 1))
		.map((l) => `${indent}// ${l}`.trimEnd());

/** Every setting with its default, grouped like the Settings editor, its description as comments. */
export function defaultSettingsJson(schemas: readonly SettingSchema[], header: string): string {
	const groups = new Map<string, SettingSchema[]>();
	for (const s of schemas) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
	const out = [...comment(header, ''), '{'];
	const entries: string[][] = [];
	for (const [group, list] of groups) {
		const block = ['', `\t// ${group}`];
		for (const s of list) {
			block.push('', ...comment(s.description, '\t'));
			const value = JSON.stringify(s.default ?? null, null, '\t').replace(/\n/g, '\n\t');
			block.push(`\t${JSON.stringify(s.id)}: ${value},`);
		}
		entries.push(block);
	}
	const lines = entries.flat();
	// No trailing comma after the last setting (JSONC allows it, but VS Code's file has none).
	for (let i = lines.length - 1; i >= 0; i--)
		if (lines[i].endsWith(',') && !lines[i].trimStart().startsWith('//')) {
			lines[i] = lines[i].slice(0, -1);
			break;
		}
	return [...out, ...lines, '}', ''].join('\n');
}

export type DefaultKeyCommand = { id: string; title: string; category?: string; key?: string; mac?: string; scope?: string };

/** The default keybindings for this platform as keybindings.json entries, then the commands that
 * have no default key (VS Code lists them as comments at the end). */
export function defaultKeybindingsJson(cmds: readonly DefaultKeyCommand[], mac: boolean, header: string, layoutNote: (scope: string) => string): string {
	const seen = new Set<string>();
	const bound: string[] = [];
	const unbound: string[] = [];
	for (const c of cmds) {
		const id = `${c.id}\u0000${c.scope ?? ''}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const key = mac ? (c.mac ?? c.key) : c.key;
		const title = c.category ? `${c.category}: ${c.title}` : c.title;
		if (key) {
			const note = c.scope ? ` (${layoutNote(c.scope)})` : '';
			bound.push(`\t// ${title}${note}`, `\t{ "key": ${JSON.stringify(key)}, "command": ${JSON.stringify(c.id)} },`);
		} else unbound.push(`// - ${c.id}: ${title}`);
	}
	if (bound.length) bound[bound.length - 1] = bound[bound.length - 1].replace(/,$/, '');
	return [...comment(header, ''), '[', ...bound, ']', '', ...(unbound.length ? ['// Commands without a default key:', ...unbound.sort()] : []), ''].join('\n');
}
