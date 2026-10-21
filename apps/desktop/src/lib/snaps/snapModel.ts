// Snaps (Kingu's packs for the IDE and the ADE; there are no extensions): the types `snap_list`
// returns (src-tauri/src/snap.rs) and the pure logic around them, so `bun test` covers it.

import type { SettingSchema } from '../settings/registry';
import { t } from '#lib/i18n/index.ts';

export type SnapSource = 'user' | 'repo';
export type SnapSettingType = 'string' | 'boolean' | 'number';
export type SettingValue = string | boolean | number;

export type SnapTask = { id: string; title: string; command: string[] };
export type SnapSetting = { key: string; type: SnapSettingType; default: SettingValue; description: string };
export type SnapMcp = { name: string; command: string[]; env: Record<string, string> };
export type SnapPermissions = { network: boolean; fs: 'worktree' | 'home'; secrets: string[] };
/** A skill folder (SKILL.md) of a snap; its files stay in Rust, which copies them into an agent plugin. */
export type SnapSkill = { name: string; path: string; description: string };
/** A command run on a Claude Code lifecycle event of an agent session (Rust `snap::Hook`). */
export type SnapHook = { event: string; command: string[]; env: Record<string, string> };
/** A hook resolved for one agent run (Rust `snap::HookRun`): settings expanded, confined like MCP servers. */
export type HookRun = { event: string; argv: string[] };
/** A program the snap runs that Kingu does not ship (`[[requires]]`, Rust `snap::Require`). */
export type SnapRequire = { program: string; setting: string | null; url: string | null; install_task: string | null; description: string };
/** A long-running process Kingu runs for the snap (`[[services]]`, Rust `snap::Service`). */
export type SnapService = { id: string; title: string; command: string[]; env: Record<string, string>; autostart: boolean; when: string | null };
/** `snap_service_list` / the `snap-service` event (Rust `snap_service::ServiceStatus`). */
export type ServiceStatus = { snapId: string; serviceId: string; running: boolean; pid: number | null; startedAt: number; endedAt: number | null; exitCode: number | null; stopped: boolean; log: string };
/** `snap_find_programs` (Rust `snap_service::Found`). */
export type FoundProgram = { path: string | null; onPath: boolean };
/** Where an installed user snap came from (`.kingu-snap.json`): git (`url`, `ref`, `commit`) or a folder (`path`). */
export type SnapOrigin = { url: string | null; ref: string | null; commit: string | null; path: string | null; installed_at: number };
/** A repo snap against `.kingu/snaps.lock` (null when the folder has no lock file). */
export type LockStatus = 'locked' | 'changed' | 'unlocked';

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
	hooks: SnapHook[];
	requires: SnapRequire[];
	services: SnapService[];
	/** README.md of the snap folder (display only). */
	readme: string | null;
	/** Files its commands run (`${snap:dir}/…` and repo paths), covered by the trust hash. */
	files: string[];
	/** Turned off by the user (`kingu.snaps.disabled`, set by the store): contributes nothing. */
	disabled?: boolean;
	origin: SnapOrigin | null;
	lock: LockStatus | null;
};

/** A snap found in a staged install source: `rel` is '' (manifest at the root) or `snaps/<id>`. */
export type SnapCandidate = { rel: string; snap: SnapInfo };
/** `snap_install_git` / `snap_install_folder` / `snap_update_prepare`: staged, not installed yet. */
export type PreparedInstall = { token: string; origin: SnapOrigin; candidates: SnapCandidate[]; existing: SnapInfo[] };

export type McpServerSpec = { command: string; args: string[]; env: Record<string, string> };

/** Unique per listed snap: a user and a repo snap may share an id. */
export const snapKey = (s: Pick<SnapInfo, 'source' | 'id'>) => `${s.source}/${s.id}`;

/** Contributes tasks and MCP servers: valid, trusted, not shadowed and not turned off. */
export const isActive = (s: SnapInfo) => !s.error && s.trusted && !s.overridden && !s.disabled;

/** The setting listing the ids of snaps the user turned off (VS Code's disabled extensions). */
export const DISABLED_SETTING = 'kingu.snaps.disabled';

/** `list` with `disabled` set from the ids in `kingu.snaps.disabled`. */
export function withDisabled(list: readonly SnapInfo[], disabled: unknown): SnapInfo[] {
	const off = new Set(Array.isArray(disabled) ? disabled.filter((x): x is string => typeof x === 'string') : []);
	return list.map((s) => (off.has(s.id) === !!s.disabled ? s : { ...s, disabled: off.has(s.id) }));
}

/** The disabled ids after turning `id` on or off. */
export function toggleDisabled(disabled: unknown, id: string, enabled: boolean): string[] {
	const ids = Array.isArray(disabled) ? disabled.filter((x): x is string => typeof x === 'string' && x !== id) : [];
	return enabled ? ids : [...ids, id].sort();
}

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
	return expandArgv(inSnapDir(snap, task.command), settingValues(snap, get));
}

/** The prefix of an argument naming a file shipped in the snap (Rust `snap::SNAP_DIR`). */
export const SNAP_DIR = '${snap:dir}';

/** `${snap:dir}/…` arguments pointed at the snap's folder (before settings, so a value never expands it). */
export const inSnapDir = (s: Pick<SnapInfo, 'dir'>, command: readonly string[]) => command.map((a) => (a.startsWith(SNAP_DIR + '/') ? s.dir + a.slice(SNAP_DIR.length) : a));

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
 * With `sandbox`, each server runs through the launcher confined to its snap's permissions in
 * `root` (the agent's worktree); when the sandbox refuses (or there is no root) servers are left out.
 */
export function mcpServersOf(list: readonly SnapInfo[], get: (id: string) => unknown = () => undefined, sandbox?: { plan: SandboxPlan; root: string | null }): Record<string, McpServerSpec> {
	const out: Record<string, McpServerSpec> = {};
	for (const s of list) {
		if (!isActive(s)) continue;
		const values = settingValues(s, get);
		for (const m of s.mcp) {
			const argv = expandArgv(inSnapDir(s, m.command), values);
			if (!argv.length) continue;
			const env = expandEnv(m.env, values);
			let run = argv;
			if (sandbox && sandbox.plan.kind !== 'off') {
				if (sandbox.plan.kind === 'refuse' || !sandbox.root) continue;
				run = sandboxedArgv(sandbox.plan, s.permissions, sandbox.root, argv, Object.keys(env), s.id);
			}
			const [command, ...args] = run;
			out[`${s.id}-${m.name}`] = { command, args, env };
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Sandbox: tasks and MCP servers run as `kingu-ptyd snap-exec … -- <argv>`, which strips
// undeclared credentials from the environment and execs sandbox-exec (macOS) or bwrap (Linux).

export const SANDBOX_SETTING = 'kingu.snaps.sandbox';
export type SandboxMode = 'enforce' | 'off';
/** `snap_sandbox_info` (src-tauri/src/snap_sandbox.rs). */
export type SandboxInfo = { enforcer: string | null; launcher: string | null; protect: string[]; problem: string | null };
export type SandboxPlan = { kind: 'enforce'; launcher: string; enforcer: string; protect: string[] } | { kind: 'off' } | { kind: 'refuse'; reason: string };

/** How snaps run here: confined, unconfined because the user turned it off, or not at all. */
export function sandboxPlan(info: SandboxInfo | null, mode: unknown): SandboxPlan {
	if (mode === 'off') return { kind: 'off' };
	if (!info) return { kind: 'refuse', reason: t('tools.snaps.sandboxNotChecked') };
	if (info.enforcer && info.launcher) return { kind: 'enforce', launcher: info.launcher, enforcer: info.enforcer, protect: info.protect };
	return { kind: 'refuse', reason: info.problem ?? t('tools.snaps.noEnforcer') };
}

/**
 * `launcher snap-exec … -- argv` for a snap's permissions. `keep` names variables the snap sets
 * itself (an MCP server's env) so the launcher does not strip them as credentials. `snap`: whose
 * keychain secrets the launcher reads (kingu_ptyd::secrets), when it declares any.
 */
export function sandboxedArgv(plan: Extract<SandboxPlan, { kind: 'enforce' }>, p: SnapPermissions, root: string, argv: readonly string[], keep: readonly string[] = [], snap?: string): string[] {
	return [
		plan.launcher,
		'snap-exec',
		'--network',
		p.network ? 'on' : 'off',
		'--fs',
		p.fs,
		'--root',
		root,
		...(snap && p.secrets.length ? ['--snap', snap] : []),
		...p.secrets.flatMap((s) => ['--secret', s]),
		...keep.flatMap((k) => ['--keep', k]),
		...plan.protect.flatMap((d) => ['--protect', d]),
		'--',
		...argv
	];
}

/** The terminal command of a task under `plan`, or why it may not run. */
export function sandboxTask(plan: SandboxPlan, p: SnapPermissions, root: string, argv: string[], snap?: string): { run: string[] } | { error: string } {
	if (plan.kind === 'off') return { run: argv };
	if (plan.kind === 'refuse') return { error: refusal(plan.reason) };
	return { run: sandboxedArgv(plan, p, root, argv, [], snap) };
}

const refusal = (reason: string) => t('tools.snaps.refusal', { reason, setting: SANDBOX_SETTING });

/** The refusal message for a plan that refuses (for the status bar). */
export const sandboxRefusal = (plan: SandboxPlan) => (plan.kind === 'refuse' ? refusal(plan.reason) : null);

/** The details page line: what enforces the permissions here. */
export function enforcementLabel(plan: SandboxPlan): { text: string; tone: 'ok' | 'warn' | 'error' } {
	if (plan.kind === 'enforce') return { text: t('tools.snaps.enforcedBy', { enforcer: plan.enforcer }), tone: 'ok' };
	if (plan.kind === 'off') return { text: t('tools.snaps.notEnforcedOff', { setting: SANDBOX_SETTING }), tone: 'warn' };
	return { text: t('tools.snaps.notEnforcedRefuse', { reason: plan.reason }), tone: 'error' };
}

/** One line for the install/trust confirm. */
export function enforcementNote(plan: SandboxPlan): string {
	if (plan.kind === 'enforce') return t('tools.snaps.noteEnforce', { enforcer: plan.enforcer });
	if (plan.kind === 'off') return t('tools.snaps.noteOff', { setting: SANDBOX_SETTING });
	return t('tools.snaps.noteRefuse', { reason: plan.reason });
}

// ---------------------------------------------------------------------------------------------
// Requirements and services

/** The program a requirement names: its setting's value when set, else `program`. */
export function requiredProgram(s: SnapInfo, r: SnapRequire, get: (id: string) => unknown): string {
	const v = r.setting ? get(settingId(s.id, r.setting)) : undefined;
	return typeof v === 'string' && v.trim() ? v.trim() : r.program;
}

export type RequireState = { require: SnapRequire; program: string; found: FoundProgram | undefined };

/** Each requirement of `s` with what `snap_find_programs` found (keyed by program). */
export function requirementStates(s: SnapInfo, get: (id: string) => unknown, found: Readonly<Record<string, FoundProgram>>): RequireState[] {
	return s.requires.map((r) => {
		const program = requiredProgram(s, r, get);
		return { require: r, program, found: found[program] };
	});
}

/** A requirement that is not installed (unknown yet counts as installed, so nothing flickers). */
export const missingRequirements = (states: readonly RequireState[]) => states.filter((r) => r.found && !r.found.path);

/** Every program the active and listed snaps require, for one `snap_find_programs` call. */
export function requiredPrograms(list: readonly SnapInfo[], get: (id: string) => unknown): string[] {
	return [...new Set(list.filter((s) => !s.error).flatMap((s) => s.requires.map((r) => requiredProgram(s, r, get))))];
}

export type ServiceRun = { snap: string; service: string; title: string; argv: string[]; env: [string, string][] };

/**
 * The services that should run now: autostart services of active snaps whose `when` setting is on
 * and whose requirements are installed, resolved like tasks (settings expanded, confined to the
 * snap's permissions in `root`). None when the sandbox refuses.
 */
export function wantedServices(list: readonly SnapInfo[], get: (id: string) => unknown, plan: SandboxPlan, root: string | null, found: Readonly<Record<string, FoundProgram>>): ServiceRun[] {
	if (plan.kind === 'refuse' || (plan.kind === 'enforce' && !root)) return [];
	const out: ServiceRun[] = [];
	for (const s of list) {
		if (!isActive(s) || !s.services.length) continue;
		if (missingRequirements(requirementStates(s, get, found)).length) continue;
		const values = settingValues(s, get);
		for (const sv of s.services) {
			if (!sv.autostart || (sv.when && values[sv.when] !== true)) continue;
			const argv = expandArgv(inSnapDir(s, sv.command), values);
			if (!argv.length) continue;
			const env = Object.entries(expandEnv(sv.env, values));
			const run = plan.kind === 'enforce' ? sandboxedArgv(plan, s.permissions, root!, argv, env.map(([k]) => k), s.id) : argv;
			out.push({ snap: s.id, service: sv.id, title: sv.title, argv: run, env });
		}
	}
	return out;
}

/** What to start (wanted, not running) and stop (running, no longer wanted). */
export function serviceChanges(wanted: readonly ServiceRun[], status: readonly ServiceStatus[]): { start: ServiceRun[]; stop: ServiceStatus[] } {
	const running = status.filter((st) => st.running);
	const isRunning = (w: ServiceRun) => running.some((st) => st.snapId === w.snap && st.serviceId === w.service);
	return {
		start: wanted.filter((w) => !isRunning(w)),
		stop: running.filter((st) => !wanted.some((w) => w.snap === st.snapId && w.service === st.serviceId))
	};
}

// ---------------------------------------------------------------------------------------------
// The catalog (snaps Kingu ships) and what a snap does for whom

export type CatalogState = 'available' | 'installed' | 'update';
export type CatalogEntry = { snap: SnapInfo; state: CatalogState; installed: SnapInfo | null };

/** Each shipped snap against the user's: not installed, installed, or installed but different (an update). */
export function catalogEntries(catalog: readonly SnapInfo[], list: readonly SnapInfo[]): CatalogEntry[] {
	return catalog
		.filter((c) => !c.error)
		.map((snap) => {
			const installed = list.find((s) => s.source === 'user' && s.id === snap.id) ?? null;
			const state: CatalogState = !installed ? 'available' : installed.hash !== snap.hash && installed.version !== snap.version ? 'update' : 'installed';
			return { snap, state, installed };
		});
}

/** The key of a shipped snap's details page (never a listed snap's `source/id`). */
export const catalogKey = (id: string) => `catalog/${id}`;

/** What the snap adds for the person in the IDE and for agents in the ADE (Kingu's two sides). */
export function audiences(s: SnapInfo): { you: string[]; agents: string[] } {
	const names = (xs: string[]) => (xs.length ? `: ${xs.join(', ')}` : '');
	const you = [
		...(s.tasks.length ? [t('tools.snaps.contrib.tasks', { count: s.tasks.length, names: names(s.tasks.map((x) => x.title)) })] : []),
		...(s.services.length ? [t('tools.snaps.contrib.services', { count: s.services.length, names: names(s.services.map((x) => x.title)) })] : []),
		...(s.settings.length ? [t('tools.snaps.contrib.settings', { count: s.settings.length })] : [])
	];
	const agents = [
		...(s.mcp.length ? [t('tools.snaps.contrib.mcp', { count: s.mcp.length, names: names(s.mcp.map((m) => m.name)) })] : []),
		...(s.skills.length ? [t('tools.snaps.contrib.skills', { count: s.skills.length, names: names(s.skills.map((k) => k.name)) })] : []),
		...(s.hooks.length ? [t('tools.snaps.contrib.hooks', { count: s.hooks.length, names: names([...new Set(s.hooks.map((h) => h.event))]) })] : [])
	];
	return { you, agents };
}

/** Which agents get what from the snap: MCP reaches every CLI Kingu knows how to give it to; skills and hooks Claude Code only. */
export function agentReach(s: SnapInfo): { agent: string; gets: string[] }[] {
	const mcp = s.mcp.length ? ['MCP'] : [];
	const claude = [...mcp, ...(s.skills.length ? ['skills'] : []), ...(s.hooks.length ? ['hooks'] : [])];
	if (!claude.length) return [];
	return [{ agent: 'Claude Code', gets: claude }, ...(mcp.length ? ['Codex', 'OpenCode', 'Copilot CLI', 'Amp'].map((agent) => ({ agent, gets: mcp })) : [])];
}

/** A stable tile color (hue) and initials for a snap without an icon. */
export function snapAvatar(s: Pick<SnapInfo, 'id' | 'name'>): { hue: number; letters: string } {
	let h = 0;
	for (const c of s.id) h = (h * 31 + c.charCodeAt(0)) % 360;
	const words = s.name
		.replace(/[^\p{L}\p{N} -]/gu, '')
		.split(/[\s-]+/)
		.filter(Boolean);
	const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? s.id).slice(0, 2)).toUpperCase();
	return { hue: h, letters };
}

/** Active snaps whose skills or hooks agents get (as plugins Rust writes into the app cache). */
export const skillSnapIds = (list: readonly SnapInfo[]) => list.filter((s) => isActive(s) && (s.skills.length > 0 || s.hooks.length > 0)).map((s) => s.id);

/**
 * The hooks of active snaps for an agent in `root`, by snap id, resolved like MCP servers: settings
 * expanded, the hook's env set through `env`, and confined to the snap's permissions in `root`.
 * A hook whose program expands to nothing is left out, and so is every hook when the sandbox
 * refuses or there is no root.
 */
export function hookRunsOf(list: readonly SnapInfo[], get: (id: string) => unknown, sandbox: { plan: SandboxPlan; root: string | null }): Record<string, HookRun[]> {
	const out: Record<string, HookRun[]> = {};
	if (sandbox.plan.kind === 'refuse' || (sandbox.plan.kind === 'enforce' && !sandbox.root)) return out;
	for (const s of list) {
		if (!isActive(s) || !s.hooks.length) continue;
		const values = settingValues(s, get);
		const runs: HookRun[] = [];
		for (const h of s.hooks) {
			const argv = expandArgv(inSnapDir(s, h.command), values);
			if (!argv.length) continue;
			const env = Object.entries(expandEnv(h.env, values));
			const run = sandbox.plan.kind === 'enforce' ? sandboxedArgv(sandbox.plan, s.permissions, sandbox.root!, argv, env.map(([k]) => k), s.id) : argv;
			runs.push({ event: h.event, argv: env.length ? ['env', ...env.map(([k, v]) => `${k}=${v}`), ...run] : run });
		}
		if (runs.length) out[s.id] = runs;
	}
	return out;
}

/** A watcher batch (workspace-relative paths) that may change the repo snaps: `.kingu/snaps` or a rescan. */
export const touchesRepoSnaps = (paths: readonly string[]) =>
	paths.some((p) => p === '' || p === '.kingu' || p === '.kingu/snaps' || p === '.kingu/snaps.lock' || p.startsWith('.kingu/snaps/'));

/** Tasks that become commands (palette and Run buttons). */
export function runnableTasks(list: readonly SnapInfo[]): { snap: SnapInfo; task: SnapTask }[] {
	return list.filter(isActive).flatMap((snap) => snap.tasks.map((task) => ({ snap, task })));
}

// ---------------------------------------------------------------------------------------------
// The Snaps view

export type SnapStatus = { key: 'active' | 'untrusted' | 'error' | 'overridden' | 'disabled'; label: string; tone: 'ok' | 'warn' | 'error' | 'muted' };

export function snapStatus(s: SnapInfo): SnapStatus {
	if (s.error) return { key: 'error', label: t('tools.snaps.status.error'), tone: 'error' };
	if (s.overridden) return { key: 'overridden', label: t('tools.snaps.status.overridden'), tone: 'muted' };
	if (!s.trusted) return { key: 'untrusted', label: t('tools.snaps.status.untrusted'), tone: 'warn' };
	if (s.disabled) return { key: 'disabled', label: t('tools.snaps.status.disabled'), tone: 'muted' };
	return { key: 'active', label: t('tools.snaps.status.active'), tone: 'ok' };
}

/** The lock note of a repo snap, or null when there is nothing to say. */
export function lockNote(s: SnapInfo): string | null {
	if (s.lock === 'changed') return t('tools.snaps.lockChanged');
	if (s.lock === 'unlocked') return t('tools.snaps.lockMissing');
	return null;
}

/** Repo snaps waiting for the user to trust them (the activity bar badge). */
export const pendingTrustCount = (list: readonly SnapInfo[]) => list.filter((s) => s.source === 'repo' && !s.error && !s.trusted).length;

/** Case-insensitive match on name, id, description and task titles; every word must match. */
export function filterSnaps(list: readonly SnapInfo[], query: string): SnapInfo[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...list];
	return list.filter((s) => {
		const text = [s.name, s.id, s.description, ...s.tasks.map((t) => t.title)].join('\n').toLowerCase();
		return words.every((w) => text.includes(w));
	});
}

/** A user snap installed from git can be updated from its origin. */
export const isUpdatable = (s: SnapInfo) => s.source === 'user' && !!s.origin?.url;

/** `url#ref @ abc1234`, or the folder it was copied from. */
export function originLabel(o: SnapOrigin | null): string {
	if (!o) return '';
	if (o.url) return `${o.url}${o.ref ? `#${o.ref}` : ''}${o.commit ? ` @ ${o.commit.slice(0, 7)}` : ''}`;
	return o.path ?? '';
}

export function permissionLines(p: SnapPermissions): string[] {
	return [
		p.network ? t('tools.snaps.perm.networkOn') : t('tools.snaps.perm.networkOff'),
		p.fs === 'home' ? t('tools.snaps.perm.fsHome') : t('tools.snaps.perm.fsWorktree'),
		`Secrets: ${p.secrets.length ? p.secrets.join(', ') : '—'}`
	];
}

/** What an update adds (`added`, to call out) and drops, permission by permission. */
export function permissionDiff(before: SnapPermissions, after: SnapPermissions): { added: string[]; removed: string[] } {
	const added: string[] = [];
	const removed: string[] = [];
	if (after.network && !before.network) added.push(t('tools.snaps.perm.useNetwork'));
	if (!after.network && before.network) removed.push(t('tools.snaps.perm.useNetwork'));
	if (after.fs === 'home' && before.fs !== 'home') added.push(t('tools.snaps.perm.homeAccess'));
	if (after.fs !== 'home' && before.fs === 'home') removed.push(t('tools.snaps.perm.homeAccess'));
	for (const s of after.secrets) if (!before.secrets.includes(s)) added.push(`secret ${s}`);
	for (const s of before.secrets) if (!after.secrets.includes(s)) removed.push(`secret ${s}`);
	return { added, removed };
}

/** Counts and names of the tasks, MCP servers and skills a snap adds. */
function contributionLines(s: SnapInfo): string[] {
	const names = (xs: string[]) => (xs.length ? `: ${xs.join(', ')}` : '');
	return [
		t('tools.snaps.contrib.tasks', { count: s.tasks.length, names: names(s.tasks.map((x) => x.title)) }),
		t('tools.snaps.contrib.mcp', { count: s.mcp.length, names: names(s.mcp.map((m) => m.name)) }),
		t('tools.snaps.contrib.skills', { count: s.skills.length, names: names(s.skills.map((k) => k.name)) }),
		...(s.hooks.length ? [t('tools.snaps.contrib.hooks', { count: s.hooks.length, names: names([...new Set(s.hooks.map((h) => h.event))]) })] : []),
		...(s.services.length ? [t('tools.snaps.contrib.services', { count: s.services.length, names: names(s.services.map((x) => x.title)) })] : [])
	];
}

/** The native confirm before an install: what it is, where from, what it may do. */
export function installSummary(s: SnapInfo, origin: SnapOrigin, plan?: SandboxPlan): string {
	return [
		`${s.name} (${s.id}) v${s.version}`,
		t('tools.snaps.from', { origin: originLabel(origin) }),
		'',
		t('tools.snaps.declaredPermissions'),
		...permissionLines(s.permissions).map((l) => `• ${l}`),
		...(plan ? [enforcementNote(plan)] : []),
		'',
		t('tools.snaps.adds'),
		...contributionLines(s).map((l) => `• ${l}`),
		'',
		t('tools.snaps.installWarning')
	].join('\n');
}

/** The native confirm before trusting a repo snap: what it may run, with the exact commands. */
export function trustSummary(s: SnapInfo, plan?: SandboxPlan): string {
	const commands = [
		...s.tasks.map((x) => t('tools.snaps.taskCommand', { title: x.title, command: x.command.join(' ') })),
		...s.mcp.map((m) => `• MCP ${m.name}: ${m.command.join(' ')}`),
		...s.hooks.map((h) => `• hook ${h.event}: ${h.command.join(' ')}`),
		...s.services.map((sv) => `• service ${sv.title}: ${sv.command.join(' ')}`)
	];
	return [
		t('tools.snaps.fromRepo', { name: s.name, id: s.id, version: s.version }),
		'',
		t('tools.snaps.declaredPermissions'),
		...permissionLines(s.permissions).map((l) => `• ${l}`),
		...(plan ? [enforcementNote(plan)] : []),
		...(commands.length ? ['', t('tools.snaps.commandsToRun'), ...commands] : []),
		...(s.skills.length ? ['', t('tools.snaps.skillsForAgents', { names: s.skills.map((k) => k.name).join(', ') })] : []),
		...(s.hooks.length ? ['', t('tools.snaps.hooksForAgents')] : []),
		...(s.files.length ? ['', t('tools.snaps.filesCovered', { files: s.files.join(', ') })] : []),
		'',
		t('tools.snaps.repoTrustWarning')
	].join('\n');
}

/** The native confirm before an update: versions, permission changes first, then the rest. */
export function updateSummary(before: SnapInfo, after: SnapInfo, origin: SnapOrigin, plan?: SandboxPlan): string {
	const { added, removed } = permissionDiff(before.permissions, after.permissions);
	const lines = [`${after.name} (${after.id}): v${before.version || '?'} → v${after.version}`, t('tools.snaps.from', { origin: originLabel(origin) }), ''];
	if (added.length) lines.push(t('tools.snaps.newPermissions'), ...added.map((a) => `• ${a}`), '');
	if (removed.length) lines.push(t('tools.snaps.droppedPermissions'), ...removed.map((r) => `• ${r}`), '');
	if (!added.length && !removed.length) lines.push(t('tools.snaps.permissionsUnchanged'), '');
	if (plan) lines.push(enforcementNote(plan), '');
	lines.push(t('tools.snaps.afterUpdate'), ...contributionLines(after).map((l) => `• ${l}`));
	return lines.join('\n');
}
