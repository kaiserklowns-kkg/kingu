// "Retry with updated sandbox permissions" (VS Code 1.147). When a sandboxed command fails
// because the sandbox stopped it, the user is offered to add what it needed (a path, or the
// domains it tried to reach) and run the command again in the sandbox, for this session or
// saved to the user's settings.
//
// VS Code's flow lives in the Copilot runtime, which reports the blocked path and the access it
// needs with a pending permission (src/vs/platform/agentHost/common/sandboxPathGrant.ts
// `ISandboxPathGrant`); the agent host shows it as "Allow sandbox path access and retry?" with
// "Allow for This Session" / "Allow for This Workspace" / "Allow for This User" / "Skip"
// (src/vs/platform/agentHost/node/copilot/copilotToolDisplay.ts `getSandboxPathGrantConfirmation`),
// grants it on the runtime's live policy and retries (copilotSessionSandbox.ts
// `grantPathForPendingRequest`); "This User" is written by the client to
// `chat.agent.sandbox.fileSystem.userConfiguredPaths` first (`sandboxPathGrantSaved`,
// `applySandboxPathGrant`). For the network the Local harness asks "Retry `{0}` command in the
// sandbox by allowing network access to {1}?" (runInTerminalTool.ts `_getAutomaticSandboxRetryTitle`).
//
// Kingu runs Arkai's Bash itself, so it finds what was blocked itself: the paths the failed
// command's output names next to a sandbox error, checked against the run's policy (profile.ts),
// and the hosts the run's proxy refused (proxy.ts) or the output and command name. It also says
// which rule blocked each one (`blockedBy`), and offers no retry when a rule the user wrote
// (deniedPaths, deniedDomains) is the cause: Kingu-only, VS Code names neither.
//
// Pure apart from the file checks passed in, so `bun test` covers it.

import { existsSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import type { SandboxConfig } from './config.ts';
import { matchesNormalized, normalizeDomainPattern, requestHost } from './domains.ts';
import { sandboxPath, type Policy } from './profile.ts';

/** What the user is offered to add (VS Code's `ISandboxPathGrant`, and its domain retry). */
export type SandboxGrant =
	| {
			kind: 'path';
			/** What the grant covers: the blocked path, or its nearest existing folder for a new file. */
			path: string;
			access: 'read' | 'readWrite';
			/** The path the command was stopped at. */
			deniedPath: string;
			/** How it is written to the user's settings (`~/…` in the home folder). */
			persistedPath: string;
			/** Read-only entries the grant replaces (an upgrade to read/write), as the user wrote them. */
			removedReadonlyPaths: string[];
	  }
	| { kind: 'domain'; domains: string[] };

/** One thing the sandbox stopped and the rule that stopped it (Kingu-only). */
export type Blocked = { target: string; rule: string };

export type Diagnosis = { grant: SandboxGrant | null; blocked: Blocked[] };

/** A host the run's proxy refused: by the domain rules, or as a local address. */
export type Refusal = { host: string; why: 'denied' | 'local' };

export type DiagnoseContext = {
	config: SandboxConfig;
	policy: Policy;
	cwd: string;
	home: string;
	/** The command that failed (hosts it names are a last resort for a network denial). */
	command: string;
	refusals: readonly Refusal[];
	exists?: (p: string) => boolean;
	realpath?: (p: string) => string;
};

const PATHS = 'chat.agent.sandbox.fileSystem.userConfiguredPaths';
const DOMAINS = 'chat.agent.sandbox.network';

/** The kernel's words for a sandbox refusal of a path; `read`: only a hidden path looks like this. */
const PATH_ERRORS: { re: RegExp; read: boolean }[] = [
	{ re: /Operation not permitted|\bEPERM\b/i, read: false },
	{ re: /Read-only file system|\bEROFS\b/i, read: false },
	// bwrap hides the home folder (a tmpfs): a file there is "missing" to the command.
	{ re: /No such file or directory|\bENOENT\b/i, read: true },
	{ re: /Permission denied|\bEACCES\b/i, read: true }
];
/** A line about writing, not reading (shell redirections, file tools, write errors). */
const WRITE_HINT =
	/Read-only file system|\bEROFS\b|\b(?:can(?:no|')t|could not|unable to|failed to) (?:create|write|lock|remove|make|move|open .* for writing|rename|overwrite|touch)|^\S*(?:ba|z|da|k)?sh(?::| line| \d)|^(?:touch|mkdir|rm|rmdir|mv|cp|ln|tee|install|chmod|truncate):|\bopen\(\) for writing|O_(?:WRONLY|RDWR|CREAT)/i;
/** Absolute or `~/` paths, quoted or bare. */
const PATH_TOKEN = /(['"`‘’“”])((?:\/|~\/)[^'"`‘’“”\n]*?)\1|(?<![\w.\-/~])((?:\/|~\/)[^\s'"`,;:()<>|]+)/g;

const under = (p: string, roots: readonly string[]) => roots.find((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)) ?? null;
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** `~/…` for a path in the home folder (how VS Code and the user write these settings). */
export function settingsPath(path: string, home: string): string {
	if (path === home) return '~';
	return path.startsWith(home + sep) ? `~/${path.slice(home.length + 1)}` : path;
}

/** The path candidates of a sandboxed command's output: each with the line it was on and how near the error it stood. */
function pathCandidates(output: string): { raw: string; line: string; read: boolean; dist: number }[] {
	const out: { raw: string; line: string; read: boolean; dist: number }[] = [];
	for (const line of output.split('\n').slice(0, 400)) {
		const err = PATH_ERRORS.find((e) => e.re.test(line));
		if (!err) continue;
		const at = line.search(err.re);
		for (const m of line.matchAll(PATH_TOKEN)) {
			const raw = (m[2] ?? m[3] ?? '').replace(/[.]+$/, '');
			if (raw.length < 2 || raw.length > 4096) continue;
			const start = m.index ?? 0;
			const end = start + m[0].length;
			out.push({ raw, line, read: err.read, dist: end <= at ? at - end : start - at });
		}
	}
	return out.sort((a, b) => a.dist - b.dist);
}

/** The nearest existing folder of a path (a new file needs its folder writable), or null. */
function existingFolder(p: string, exists: (p: string) => boolean): string | null {
	let cur = dirname(p);
	for (let i = 0; i < 64 && cur !== dirname(cur); i++, cur = dirname(cur)) if (exists(cur)) return cur;
	return null;
}

/** A grant that would open the whole disk or the whole home folder is never offered. */
const tooBroad = (p: string, home: string) => p === '/' || p === home || home.startsWith(p + sep);

/** Which of the user's own entries (as written) resolve to a path covering `p`. */
function entriesCovering(entries: readonly string[], p: string, fix: (x: string) => string): string[] {
	return entries.filter((e) => under(p, [fix(e)]) !== null);
}

function diagnosePath(ctx: DiagnoseContext, exists: (p: string) => boolean, output: string): Diagnosis {
	const fix = (x: string) => sandboxPath(x, ctx.cwd, ctx.home, ctx.realpath);
	const { policy: p, config: c } = ctx;
	const blocked: Blocked[] = [];
	for (const cand of pathCandidates(output)) {
		const path = fix(cand.raw);
		const shown = settingsPath(path, ctx.home);
		const denied = entriesCovering(c.deniedPaths, path, fix);
		if (denied.length || under(path, p.denied)) {
			blocked.push({ target: shown, rule: `${PATHS}.deniedPaths${denied.length ? ` entry ${code(denied[0]!)}` : ''}` });
			return { grant: null, blocked };
		}
		const readable = p.readRoot === null || under(path, [p.readRoot]) === null || under(path, p.readable) !== null;
		const writable = under(path, p.writable) !== null && under(path, p.readonly) === null;
		const there = exists(path);
		if (!readable) {
			const write = WRITE_HINT.test(cand.line);
			// A path that is not there and is not being written is really missing.
			if (!there && (!write || cand.read)) continue;
			let target = path;
			if (!there) {
				const folder = existingFolder(path, exists);
				target = folder && !tooBroad(folder, ctx.home) ? folder : path;
			}
			if (tooBroad(target, ctx.home)) continue;
			blocked.push({ target: shown, rule: `the home folder, which sandboxed commands cannot read outside the project folder, $TMPDIR and ${PATHS}.readonlyPaths / readwritePaths` });
			return { grant: { kind: 'path', path: target, access: write ? 'readWrite' : 'read', deniedPath: path, persistedPath: settingsPath(target, ctx.home), removedReadonlyPaths: [] }, blocked };
		}
		// A missing file or a refused read outside the policy is the file system's own answer, not the sandbox's.
		if (cand.read || !readable || writable) continue;
		const readonly = entriesCovering(c.readonlyPaths, path, fix);
		if (readonly.length) {
			const target = fix(readonly[0]!);
			blocked.push({ target: shown, rule: `${PATHS}.readonlyPaths entry ${code(readonly[0]!)}` });
			return { grant: { kind: 'path', path: target, access: 'readWrite', deniedPath: path, persistedPath: readonly[0]!, removedReadonlyPaths: readonly }, blocked };
		}
		if (under(path, p.readonly)) {
			blocked.push({ target: shown, rule: "the repository's git hooks and config, which stay read-only because they run code outside the sandbox later" });
			return { grant: null, blocked };
		}
		const target = there ? path : existingFolder(path, exists);
		if (!target || tooBroad(target, ctx.home)) continue;
		blocked.push({ target: shown, rule: `the folders sandboxed commands may write: the project folder, $TMPDIR and ${PATHS}.readwritePaths` });
		return { grant: { kind: 'path', path: target, access: 'readWrite', deniedPath: path, persistedPath: settingsPath(target, ctx.home), removedReadonlyPaths: [] }, blocked };
	}
	return { grant: null, blocked };
}

/** Hosts a network failure names, in the order they appear. */
const HOST_IN_OUTPUT = [
	/network access blocked: (\S+) is/g,
	/Could not resolve host(?:name)?:?\s+([^\s'";,:]+)/gi,
	/getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([^\s'",)]+)/g,
	/Failed to connect to ([^\s]+) port/g,
	/connect to host ([^\s]+) port/g,
	/unable to access '[a-z][a-z0-9+.-]*:\/\/(?:[^@/']+@)?([^/:']+)/gi,
	/Temporary failure in name resolution[^\n]*?\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi
];
const HOST_IN_COMMAND = [/\b(?:https?|wss?|git|ssh|ftp):\/\/(?:[^@/\s'"]+@)?([^/:\s'"]+)/gi, /\b[\w.-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+):/gi];

function hostsIn(text: string, patterns: RegExp[]): string[] {
	const out: string[] = [];
	for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]!);
	return out;
}

const LOCAL_NAME = /^(?:localhost|.*\.localhost|.*\.local|127(?:\.\d+){3}|0\.0\.0\.0|\[::1?\]|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|169\.254(?:\.\d+){2})$/;

function diagnoseNetwork(ctx: DiagnoseContext, output: string): Diagnosis {
	const c = ctx.config;
	const seen = new Set<string>();
	const blocked: Blocked[] = [];
	const grantable: string[] = [];
	const consider = (raw: string, local: boolean) => {
		const host = requestHost(raw);
		if (!host || seen.has(host)) return;
		seen.add(host);
		if (local || LOCAL_NAME.test(host)) {
			blocked.push({ target: host, rule: `${DOMAINS}.allowLocalNetwork (off: this machine and the local network are closed)` });
			return;
		}
		const deny = c.deniedDomains.find((d) => matchesNormalized(host, d));
		if (deny) return void blocked.push({ target: host, rule: `${DOMAINS}.deniedDomains entry ${code(deny)}` });
		if (c.allowedDomains.length) {
			if (c.allowedDomains.some((d) => matchesNormalized(host, d))) return;
			blocked.push({ target: host, rule: `${DOMAINS}.allowedDomains (it is not in the list)` });
		} else if (!c.allowNetwork) blocked.push({ target: host, rule: `${DOMAINS}.allowNetwork (off: no outbound network)` });
		else return;
		if (normalizeDomainPattern(host)) grantable.push(host);
	};
	for (const r of ctx.refusals) consider(r.host, r.why === 'local');
	for (const h of hostsIn(output.slice(0, 20_000), HOST_IN_OUTPUT)) consider(h, false);
	// The command's own URLs only when nothing else named a host (VS Code reads them before running).
	if (!seen.size) for (const h of hostsIn(ctx.command.slice(0, 4000), HOST_IN_COMMAND)) consider(h, false);
	const domains = grantable.slice(0, 10);
	// A host a rule the user wrote denies is never offered, nor is anything alongside it.
	const ruled = blocked.some((b) => !grantable.includes(b.target));
	return { grant: domains.length && !ruled ? { kind: 'domain', domains } : null, blocked };
}

/**
 * What the sandbox stopped in a failed command (`denial` from `classifyDenial`), the rule that
 * stopped it, and the grant to offer, if any.
 */
export function diagnose(denial: 'network' | 'filesystem' | null, output: string, ctx: DiagnoseContext): Diagnosis {
	const exists = ctx.exists ?? existsSync;
	// The proxy's own refusals are certain, whatever the output looks like.
	if (denial === 'network' || ctx.refusals.length) {
		const net = diagnoseNetwork(ctx, output);
		if (net.grant || net.blocked.length || denial === 'network') return net;
	}
	return diagnosePath(ctx, exists, output);
}

/** The run's settings with a grant applied for the rest of the session. */
export function applyGrant(c: SandboxConfig, g: SandboxGrant): SandboxConfig {
	if (g.kind === 'domain') return { ...c, allowedDomains: [...new Set([...c.allowedDomains, ...g.domains])] };
	const removed = new Set(g.removedReadonlyPaths);
	const readonlyPaths = c.readonlyPaths.filter((x) => !removed.has(x));
	return g.access === 'read'
		? { ...c, readonlyPaths: [...new Set([...readonlyPaths, g.path])] }
		: { ...c, readonlyPaths, readwritePaths: [...new Set([...c.readwritePaths, g.path])] };
}

/** "`a.com`" or "`a.com` and N more domains" (VS Code's `_formatBlockedDomainsForTitle`). */
export function domainsLabel(domains: readonly string[]): string {
	return domains.length === 1 ? code(domains[0]!) : `${code(domains[0]!)} and ${domains.length - 1} more domains`;
}

/** The prompt's title and text, in VS Code's words. */
export function grantPrompt(g: SandboxGrant, home: string, blocked: readonly Blocked[]): { title: string; detail: string } {
	const why = blocked.length ? `\n\nBlocked by ${blocked.map((b) => `${code(b.target)}: ${b.rule}`).join('; ')}.` : '';
	if (g.kind === 'domain') return { title: `Retry \`Bash\` command in the sandbox by allowing network access to ${domainsLabel(g.domains)}?`, detail: `Allow network access to ${g.domains.map(code).join(', ')} and retry inside the sandbox.${why}` };
	const path = code(settingsPath(g.path, home));
	const text = g.removedReadonlyPaths.length
		? `Change access to ${path} from read-only to read/write and retry inside the sandbox.`
		: g.access === 'read'
			? `Allow read access to ${path} and retry inside the sandbox.`
			: `Allow read/write access to ${path} and retry inside the sandbox.`;
	const denied = g.deniedPath !== g.path ? `\n\nThe blocked path was ${code(settingsPath(g.deniedPath, home))}. Access will cover ${path}, including its contents if it is a folder.` : '';
	return { title: 'Allow sandbox path access and retry?', detail: `${text}${denied}${why}` };
}

/** "Blocked by …" for the model's failure note (Kingu-only). */
export function blockedLine(blocked: readonly Blocked[]): string | null {
	return blocked.length ? `- Blocked by: ${blocked.map((b) => `${b.target} (${b.rule})`).join('; ')}.` : null;
}

/** The `sandbox_grant` of a `permission_request` (protocol.ts `SandboxGrantWire`). */
export type SandboxGrantWire =
	| { kind: 'path'; path: string; access: 'read' | 'readWrite'; denied_path: string; persisted_path: string; removed_readonly_paths: string[]; blocked: Blocked[] }
	| { kind: 'domain'; domains: string[]; blocked: Blocked[] };

export function grantWire(g: SandboxGrant, blocked: readonly Blocked[]): SandboxGrantWire {
	const b = blocked.slice(0, 10);
	return g.kind === 'domain'
		? { kind: 'domain', domains: g.domains, blocked: b }
		: { kind: 'path', path: g.path, access: g.access, denied_path: g.deniedPath, persisted_path: g.persistedPath, removed_readonly_paths: g.removedReadonlyPaths, blocked: b };
}
