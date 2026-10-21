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
/**
 * `[permissions]` of snap.toml. The lists are optional narrowing (Rust leaves empty ones out):
 * `hosts` (with network), `read` / `write` scopes, `processes` it may start, `env` it gets.
 */
export type SnapPermissions = {
	network: boolean;
	fs: 'worktree' | 'home';
	secrets: string[];
	hosts?: string[];
	read?: string[];
	write?: string[];
	processes?: string[];
	env?: string[];
};
/** A file covered by a snap's trust hash. */
export type FileHash = { path: string; sha256: string };
/** A skill folder (SKILL.md) of a snap; its files stay in Rust, which copies them into an agent plugin. */
export type SnapSkill = { name: string; path: string; description: string };
/** Where an installed user snap came from (`.kingu-snap.json`): git (`url`, `ref`, `commit`), a folder (`path`) or the team library (`team`). */
export type SnapOrigin = { url: string | null; ref: string | null; commit: string | null; path: string | null; team?: { server: string; version: string } | null; installed_at: number };
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
	/** Repo snaps: repo files their commands run (`scripts/ci.sh`); they are in `hash` too. */
	scripts: FileHash[];
	origin: SnapOrigin | null;
	/** Repo snaps against `.kingu/snaps.lock`; user snaps when the lock pins a team snap with their id. */
	lock: LockStatus | null;
	/** Repo snaps: the permissions approved last time (trust or lock), to show what grew. */
	approved_permissions: SnapPermissions | null;
};

/** `snap_lock_verify` (snap_install.rs LockReport). */
export type LockReport = {
	id: string;
	source: 'repo' | 'team';
	status: 'locked' | 'changed' | 'unlocked' | 'missing';
	lockedVersion: string | null;
	version: string | null;
	files: string[];
	scripts: string[];
	lockedPermissions: SnapPermissions | null;
	permissions: SnapPermissions | null;
};

/** A snap found in a staged install source: `rel` is '' (manifest at the root) or `snaps/<id>`. */
export type SnapCandidate = { rel: string; snap: SnapInfo };
/** `snap_install_git` / `snap_install_folder` / `snap_update_prepare`: staged, not installed yet. */
export type PreparedInstall = { token: string; origin: SnapOrigin; candidates: SnapCandidate[]; existing: SnapInfo[] };

export type McpServerSpec = { command: string; args: string[]; env: Record<string, string> };

/** Unique per listed snap: a user and a repo snap may share an id. */
export const snapKey = (s: Pick<SnapInfo, 'source' | 'id'>) => `${s.source}/${s.id}`;

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
 * With `sandbox`, each server runs through the launcher confined to its snap's permissions in
 * `root` (the agent's worktree); when the sandbox refuses (or there is no root) servers are left out.
 */
export function mcpServersOf(list: readonly SnapInfo[], get: (id: string) => unknown = () => undefined, sandbox?: { plan: SandboxPlan; root: string | null }): Record<string, McpServerSpec> {
	const out: Record<string, McpServerSpec> = {};
	for (const s of list) {
		if (!isActive(s)) continue;
		const values = settingValues(s, get);
		for (const m of s.mcp) {
			const argv = expandArgv(m.command, values);
			if (!argv.length) continue;
			const env = expandEnv(m.env, values);
			let run = argv;
			if (sandbox && sandbox.plan.kind !== 'off') {
				if (sandbox.plan.kind === 'refuse' || !sandbox.root) continue;
				run = sandboxedArgv(sandbox.plan, s.permissions, sandbox.root, argv, Object.keys(env));
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
 * itself (an MCP server's env) so the launcher does not strip them as credentials.
 */
export function sandboxedArgv(plan: Extract<SandboxPlan, { kind: 'enforce' }>, p: SnapPermissions, root: string, argv: readonly string[], keep: readonly string[] = []): string[] {
	return [
		plan.launcher,
		'snap-exec',
		'--network',
		p.network ? 'on' : 'off',
		'--fs',
		p.fs,
		'--root',
		root,
		...p.secrets.flatMap((s) => ['--secret', s]),
		...keep.flatMap((k) => ['--keep', k]),
		...plan.protect.flatMap((d) => ['--protect', d]),
		'--',
		...argv
	];
}

/** The terminal command of a task under `plan`, or why it may not run. */
export function sandboxTask(plan: SandboxPlan, p: SnapPermissions, root: string, argv: string[]): { run: string[] } | { error: string } {
	if (plan.kind === 'off') return { run: argv };
	if (plan.kind === 'refuse') return { error: refusal(plan.reason) };
	return { run: sandboxedArgv(plan, p, root, argv) };
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

/** Active snaps whose skills agents get (as plugins Rust writes into the app cache). */
export const skillSnapIds = (list: readonly SnapInfo[]) => list.filter((s) => isActive(s) && s.skills.length > 0).map((s) => s.id);

/** A watcher batch (workspace-relative paths) that may change the repo snaps: `.kingu/snaps` or a rescan. */
export const touchesRepoSnaps = (paths: readonly string[]) =>
	paths.some((p) => p === '' || p === '.kingu' || p === '.kingu/snaps' || p === '.kingu/snaps.lock' || p.startsWith('.kingu/snaps/'));

/** Tasks that become commands (palette and Run buttons). */
export function runnableTasks(list: readonly SnapInfo[]): { snap: SnapInfo; task: SnapTask }[] {
	return list.filter(isActive).flatMap((snap) => snap.tasks.map((task) => ({ snap, task })));
}

// ---------------------------------------------------------------------------------------------
// The Snaps view

export type SnapStatus = { key: 'active' | 'untrusted' | 'error' | 'overridden'; label: string; tone: 'ok' | 'warn' | 'error' | 'muted' };

export function snapStatus(s: SnapInfo): SnapStatus {
	if (s.error) return { key: 'error', label: t('tools.snaps.status.error'), tone: 'error' };
	if (s.overridden) return { key: 'overridden', label: t('tools.snaps.status.overridden'), tone: 'muted' };
	if (!s.trusted) return { key: 'untrusted', label: t('tools.snaps.status.untrusted'), tone: 'warn' };
	return { key: 'active', label: t('tools.snaps.status.active'), tone: 'ok' };
}

/** The lock note of a repo snap, or null when there is nothing to say. */
export function lockNote(s: SnapInfo): string | null {
	if (s.lock === 'changed') return s.source === 'user' ? t('snapPlatform.lockTeamChanged') : t('snapPlatform.lockChangedUntrusted');
	if (s.lock === 'unlocked') return t('tools.snaps.lockMissing');
	return null;
}

/** `Snap: Verify snaps.lock` as text for a message box: one line per entry, then what changed. */
export function lockReportText(rows: readonly LockReport[]): string {
	if (!rows.length) return t('snapPlatform.verify.empty');
	const lines: string[] = [];
	for (const r of rows) {
		const from = r.source === 'team' ? ` (${t('snapPlatform.verify.team')})` : '';
		const versions = r.lockedVersion && r.version && r.lockedVersion !== r.version ? ` v${r.lockedVersion} → v${r.version}` : r.version ? ` v${r.version}` : r.lockedVersion ? ` v${r.lockedVersion}` : '';
		lines.push(`${r.status === 'locked' ? '✓' : '✗'} ${r.id}${from}${versions}: ${t(`snapPlatform.verify.${r.status}`)}`);
		for (const f of r.files) lines.push(`    ${f}`);
		for (const f of r.scripts) lines.push(`    ${t('snapPlatform.verify.script', { path: f })}`);
		if (r.lockedPermissions && r.permissions) for (const a of permissionDiff(r.lockedPermissions, r.permissions).added) lines.push(`    + ${a}`);
	}
	return lines.join('\n');
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
	const join = (xs: readonly string[] | undefined) => (xs?.length ? xs.join(', ') : null);
	const [read, write, processes, env] = [join(p.read), join(p.write), join(p.processes), join(p.env)];
	return [
		p.network ? (p.hosts?.length ? t('snapPlatform.perm.hosts', { list: p.hosts.join(', ') }) : t('tools.snaps.perm.networkOn')) : t('tools.snaps.perm.networkOff'),
		p.fs === 'home' ? t('tools.snaps.perm.fsHome') : t('tools.snaps.perm.fsWorktree'),
		...(read ? [t('snapPlatform.perm.read', { list: read })] : []),
		...(write ? [t('snapPlatform.perm.write', { list: write })] : []),
		...(processes ? [t('snapPlatform.perm.processes', { list: processes })] : []),
		...(env ? [t('snapPlatform.perm.env', { list: env })] : []),
		`Secrets: ${p.secrets.length ? p.secrets.join(', ') : '—'}`
	];
}

/**
 * What an update adds (`added`, to call out) and drops, permission by permission. Narrowing
 * lists count the other way round: dropping `hosts`, `read`, `processes` or `env` restrictions
 * widens what the snap may do, adding entries to `write` widens it too.
 */
export function permissionDiff(before: SnapPermissions, after: SnapPermissions): { added: string[]; removed: string[] } {
	const added: string[] = [];
	const removed: string[] = [];
	if (after.network && !before.network) added.push(t('tools.snaps.perm.useNetwork'));
	if (!after.network && before.network) removed.push(t('tools.snaps.perm.useNetwork'));
	if (after.fs === 'home' && before.fs !== 'home') added.push(t('tools.snaps.perm.homeAccess'));
	if (after.fs !== 'home' && before.fs === 'home') removed.push(t('tools.snaps.perm.homeAccess'));
	for (const s of after.secrets) if (!before.secrets.includes(s)) added.push(`secret ${s}`);
	for (const s of before.secrets) if (!after.secrets.includes(s)) removed.push(`secret ${s}`);
	for (const w of after.write ?? []) if (!(before.write ?? []).includes(w)) added.push(t('snapPlatform.diff.write', { path: w }));
	for (const w of before.write ?? []) if (!(after.write ?? []).includes(w)) removed.push(t('snapPlatform.diff.write', { path: w }));
	// An allow-list: an entry more widens; the list going away lifts the restriction entirely.
	const allowList = (key: 'hosts' | 'read' | 'processes' | 'env', item: (value: string) => string, any: string) => {
		const b = before[key] ?? [];
		const a = after[key] ?? [];
		if (key === 'hosts' && !after.network) return;
		if (b.length && !a.length) added.push(any);
		else if (a.length) {
			for (const x of a) if (b.length && !b.includes(x)) added.push(item(x));
			for (const x of b) if (!a.includes(x)) removed.push(item(x));
			if (!b.length) removed.push(any);
		}
	};
	allowList('hosts', (value) => t('snapPlatform.diff.host', { value }), t('snapPlatform.diff.anyHost'));
	allowList('read', (value) => t('snapPlatform.diff.read', { value }), t('snapPlatform.diff.anyRead'));
	allowList('processes', (value) => t('snapPlatform.diff.process', { value }), t('snapPlatform.diff.anyProcess'));
	allowList('env', (value) => t('snapPlatform.diff.env', { value }), t('snapPlatform.diff.anyEnv'));
	return { added, removed };
}

/** Whether going from `before` to `after` lets the snap do more (the review prompt must say so). */
export const permissionsGrew = (before: SnapPermissions | null | undefined, after: SnapPermissions) => !!before && permissionDiff(before, after).added.length > 0;

/** Counts and names of the tasks, MCP servers and skills a snap adds. */
function contributionLines(s: SnapInfo): string[] {
	const names = (xs: string[]) => (xs.length ? `: ${xs.join(', ')}` : '');
	return [
		t('tools.snaps.contrib.tasks', { count: s.tasks.length, names: names(s.tasks.map((x) => x.title)) }),
		t('tools.snaps.contrib.mcp', { count: s.mcp.length, names: names(s.mcp.map((m) => m.name)) }),
		t('tools.snaps.contrib.skills', { count: s.skills.length, names: names(s.skills.map((k) => k.name)) })
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
	const commands = [...s.tasks.map((x) => t('tools.snaps.taskCommand', { title: x.title, command: x.command.join(' ') })), ...s.mcp.map((m) => `• MCP ${m.name}: ${m.command.join(' ')}`)];
	const grown = s.approved_permissions ? permissionDiff(s.approved_permissions, s.permissions).added : [];
	return [
		t('tools.snaps.fromRepo', { name: s.name, id: s.id, version: s.version }),
		...(s.lock === 'changed' ? ['', t('snapPlatform.lockReapprove')] : []),
		...(grown.length ? ['', t('snapPlatform.permissionsGrew'), ...grown.map((a) => `• ${a}`)] : []),
		'',
		t('tools.snaps.declaredPermissions'),
		...permissionLines(s.permissions).map((l) => `• ${l}`),
		...(plan ? [enforcementNote(plan)] : []),
		...(commands.length ? ['', t('tools.snaps.commandsToRun'), ...commands] : []),
		...(s.skills.length ? ['', t('tools.snaps.skillsForAgents', { names: s.skills.map((k) => k.name).join(', ') })] : []),
		...(s.scripts?.length ? ['', t('snapPlatform.scriptsPinned', { list: s.scripts.map((f) => f.path).join(', ') })] : []),
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
