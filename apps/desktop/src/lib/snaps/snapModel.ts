// Snaps (Kingu's packs for the IDE and the ADE; there are no extensions): the types `snap_list`
// returns (src-tauri/src/snap.rs) and the pure logic around them, so `bun test` covers it.

import type { SettingSchema } from '../settings/registry';

export type SnapSource = 'user' | 'repo';
export type SnapSettingType = 'string' | 'boolean' | 'number';
export type SettingValue = string | boolean | number;

export type SnapTask = { id: string; title: string; command: string[] };
export type SnapSetting = { key: string; type: SnapSettingType; default: SettingValue; description: string };
export type SnapMcp = { name: string; command: string[]; env: Record<string, string> };
export type SnapPermissions = { network: boolean; fs: 'worktree' | 'home'; secrets: string[] };
/** A skill folder (SKILL.md) of a snap; its files stay in Rust, which copies them into an agent plugin. */
export type SnapSkill = { name: string; path: string; description: string };

export type SnapInfo = {
	id: string;
	name: string;
	version: string;
	description: string;
	source: SnapSource;
	dir: string;
	/** User snaps always; repo snaps once the user trusted this exact manifest in this folder. */
	trusted: boolean;
	error: string | null;
	/** A user snap shadowed by a repo snap with the same id. */
	overridden: boolean;
	/** SHA-256 of snap.toml, passed back to `snap_trust` so a changed manifest is never trusted blindly. */
	hash: string;
	permissions: SnapPermissions;
	tasks: SnapTask[];
	settings: SnapSetting[];
	mcp: SnapMcp[];
	skills: SnapSkill[];
};

export type McpServerSpec = { command: string; args: string[]; env: Record<string, string> };

/** Contributes tasks and MCP servers: valid, trusted and not shadowed. */
export const isActive = (s: SnapInfo) => !s.error && s.trusted && !s.overridden;

/** Contributes settings: valid and not shadowed. Untrusted snaps' settings are only data, so they show. */
export const contributesSettings = (s: SnapInfo) => !s.error && !s.overridden;

export const settingId = (snapId: string, key: string) => `snap.${snapId}.${key}`;
export const taskCommandId = (snapId: string, taskId: string) => `snap.${snapId}.${taskId}`;
export const settingsGroup = (s: Pick<SnapInfo, 'name'>) => `Snap: ${s.name}`;

const PLACEHOLDER = /\$\{setting:([^}]*)\}/g;
const WHOLE = /^\$\{setting:([^}]*)\}$/;

/**
 * argv with `${setting:<key>}` replaced by the setting's whole value (never split on spaces).
 * An argument that is only a placeholder is dropped when the value is empty, so an empty
 * `testFlags` does not pass `""` to the tool. Unknown keys read as empty (Rust rejects them).
 */
export function expandCommand(command: readonly string[], values: Record<string, SettingValue | undefined>): string[] {
	const text = (key: string) => {
		const v = values[key];
		return v === undefined || v === null ? '' : String(v);
	};
	const out: string[] = [];
	for (const arg of command) {
		const whole = WHOLE.exec(arg);
		if (whole) {
			const v = text(whole[1]);
			if (v !== '') out.push(v);
			continue;
		}
		out.push(arg.replace(PLACEHOLDER, (_, key: string) => text(key)));
	}
	return out;
}

/**
 * Settings registry entries for the system settings page. A user snap's settings are user-only
 * (`application`): otherwise a cloned repo's `.kingu/settings.json` could inject arguments into a
 * command the user trusted. A repo snap's settings may also be set per folder; the repo controls
 * that snap anyway.
 */
export function snapSettingSchemas(list: readonly SnapInfo[]): SettingSchema[] {
	const out: SettingSchema[] = [];
	for (const s of list) {
		if (!contributesSettings(s)) continue;
		const base = { group: settingsGroup(s), scope: s.source === 'user' ? ('application' as const) : undefined };
		for (const st of s.settings) {
			const id = settingId(s.id, st.key);
			const description = st.description || `${st.key} (${s.name})`;
			if (st.type === 'boolean') out.push({ ...base, id, description, type: 'boolean', default: st.default === true });
			else if (st.type === 'number') out.push({ ...base, id, description, type: 'number', default: typeof st.default === 'number' ? st.default : 0 });
			else out.push({ ...base, id, description, type: 'string', default: typeof st.default === 'string' ? st.default : '' });
		}
	}
	return out;
}

/**
 * env values with the same rules as `expandCommand`: a value that is only a placeholder becomes
 * the setting's whole value and the variable is left out when that is empty; elsewhere text is
 * replaced in one pass.
 */
export function expandEnv(env: Readonly<Record<string, string>>, values: Record<string, SettingValue | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		const [v] = expandCommand([value], values);
		if (v !== undefined) out[name] = v;
	}
	return out;
}

/** A snap's setting values through `get` (the settings service), falling back to the defaults. */
function settingValues(snap: SnapInfo, get: (id: string) => unknown): Record<string, SettingValue | undefined> {
	const values: Record<string, SettingValue | undefined> = {};
	for (const st of snap.settings) {
		const v = get(settingId(snap.id, st.key));
		values[st.key] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : st.default;
	}
	return values;
}

/** The argv to run for a task, its settings read through `get` (the settings service). */
export function taskArgv(snap: SnapInfo, task: SnapTask, get: (id: string) => unknown): string[] {
	return expandArgv(task.command, settingValues(snap, get));
}

/**
 * `expandCommand` for a whole argv: when the program itself expands to nothing the result is
 * empty, never the next argument promoted to program.
 */
export function expandArgv(command: readonly string[], values: Record<string, SettingValue | undefined>): string[] {
	const [program] = expandCommand(command.slice(0, 1), values);
	if (!program?.trim()) return [];
	return [program, ...expandCommand(command.slice(1), values)];
}

/**
 * MCP servers handed to agents: active snaps only, keyed `<snapId>-<serverName>`, with
 * `${setting:…}` expanded in command and env. A server whose program expands to nothing is left out.
 */
export function mcpServersOf(list: readonly SnapInfo[], get: (id: string) => unknown = () => undefined): Record<string, McpServerSpec> {
	const out: Record<string, McpServerSpec> = {};
	for (const s of list) {
		if (!isActive(s)) continue;
		const values = settingValues(s, get);
		for (const m of s.mcp) {
			const [command, ...args] = expandArgv(m.command, values);
			if (!command) continue;
			out[`${s.id}-${m.name}`] = { command, args, env: expandEnv(m.env, values) };
		}
	}
	return out;
}

/** Active snaps whose skills agents get (as plugins Rust writes into the app cache). */
export const skillSnapIds = (list: readonly SnapInfo[]) => list.filter((s) => isActive(s) && s.skills.length > 0).map((s) => s.id);

/** A watcher batch (workspace-relative paths) that may change the repo snaps: `.kingu/snaps` or a rescan. */
export const touchesRepoSnaps = (paths: readonly string[]) => paths.some((p) => p === '' || p === '.kingu' || p === '.kingu/snaps' || p.startsWith('.kingu/snaps/'));

/** Tasks that become commands (palette and Run buttons). */
export function runnableTasks(list: readonly SnapInfo[]): { snap: SnapInfo; task: SnapTask }[] {
	return list.filter(isActive).flatMap((snap) => snap.tasks.map((task) => ({ snap, task })));
}
