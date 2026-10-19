// Skills hub, pure parts (testable with `bun test`): the types Rust returns (src-tauri/src/skill_hub,
// team/skills.rs), the labels of sources and review flags, the review's risk line and the state of a
// team-shared skill against what is installed here.

import { t, type MessageKey } from '#lib/i18n/index.ts';

export type SkillSource = 'managed' | 'snap' | 'builtin' | 'project' | 'user';

/** Mirrors `skill_hub::install::Origin`. */
export type SkillOrigin = {
	kind: 'git' | 'archive' | 'file' | 'folder';
	url: string | null;
	ref: string | null;
	commit: string | null;
	archiveSha256: string | null;
	local: string | null;
	path: string;
	hash: string;
	installedAt: number;
};

/** Mirrors `skill_hub::package::Flag`. */
export type SkillFlag =
	| { kind: 'executable'; path: string }
	| { kind: 'script'; path: string }
	| { kind: 'binary'; path: string }
	| { kind: 'allowedTools'; tools: string }
	| { kind: 'renamed'; folder: string }
	| { kind: 'hiddenSkipped'; count: number };

/** Mirrors `skill_hub::SkillInfo` (`skill_hub_list`). */
export type SkillInfo = {
	id: string;
	source: SkillSource;
	name: string;
	description: string;
	dir: string | null;
	enabled: boolean;
	toggleable: boolean;
	inactive: boolean;
	error: string | null;
	snap: string | null;
	origin: SkillOrigin | null;
	flags: SkillFlag[];
	shareLink: string | null;
};

export type SkillFile = { path: string; size: number; executable: boolean };

/** Mirrors `skill_hub::install::Candidate`. */
export type SkillCandidate = {
	rel: string;
	name: string;
	description: string;
	allowedTools: string | null;
	files: SkillFile[];
	flags: SkillFlag[];
	hash: string;
	skillMd: string;
	truncated: boolean;
	error: string | null;
};

/** Mirrors `skill_hub::install::Prepared`. */
export type PreparedSkills = { token: string; origin: SkillOrigin; candidates: SkillCandidate[]; existing: string[] };

/** Mirrors `team::skills::TeamSkill` (snake_case, like the server). */
export type TeamSkill = {
	skill_name: string;
	description: string;
	git_url: string;
	git_ref: string | null;
	path: string;
	commit_sha: string;
	content_sha256: string;
	shared_by: string;
	shared_at: string;
	note: string | null;
};

export type TeamSkills = { server: string; user_id: string; role: string; items: TeamSkill[] };

export const SOURCE_LABEL = {
	managed: 'skills.source.managed',
	snap: 'skills.source.snap',
	builtin: 'skills.source.builtin',
	project: 'skills.source.project',
	user: 'skills.source.user'
} as const satisfies Record<SkillSource, MessageKey>;

/** The order of the view's sections. */
export const SOURCE_ORDER: readonly SkillSource[] = ['managed', 'snap', 'builtin', 'project', 'user'];

export function groupBySource(list: readonly SkillInfo[]): { source: SkillSource; items: SkillInfo[] }[] {
	return SOURCE_ORDER.map((source) => ({ source, items: list.filter((s) => s.source === source) })).filter((g) => g.items.length > 0);
}

/** Whether a skill reaches agents started now. */
export const isLive = (s: SkillInfo) => s.enabled && !s.inactive && !s.error;

export function flagText(f: SkillFlag): string {
	switch (f.kind) {
		case 'executable':
			return t('skills.flag.executable', { path: f.path });
		case 'script':
			return t('skills.flag.script', { path: f.path });
		case 'binary':
			return t('skills.flag.binary', { path: f.path });
		case 'allowedTools':
			return t('skills.flag.allowedTools', { tools: f.tools });
		case 'renamed':
			return t('skills.flag.renamed', { folder: f.folder });
		case 'hiddenSkipped':
			return t('skills.flag.hiddenSkipped', { count: f.count });
	}
}

/** Flags that deserve the warning colour: what can run or act without asking. */
export const isRisky = (f: SkillFlag) => f.kind === 'executable' || f.kind === 'script' || f.kind === 'binary' || f.kind === 'allowedTools';

/** One flag per path, risky first (a script with an executable bit is listed once, as executable). */
export function reviewFlags(flags: readonly SkillFlag[]): SkillFlag[] {
	const seen = new Set<string>();
	const out: SkillFlag[] = [];
	const rank = { binary: 0, executable: 1, script: 2, allowedTools: 3, renamed: 4, hiddenSkipped: 5 } as const;
	for (const f of [...flags].sort((a, b) => rank[a.kind] - rank[b.kind])) {
		const key = 'path' in f ? f.path : f.kind;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

/** Where an installed (or staged) skill comes from, on one line. */
export function originLabel(o: SkillOrigin): string {
	const where = (o.url ?? o.local ?? '').replace(/^https:\/\//, '').replace(/\.git$/, '');
	const parts = [where];
	if (o.ref) parts.push(`@ ${o.ref}`);
	if (o.path) parts.push(`· ${o.path}`);
	if (o.commit) parts.push(`(${short(o.commit)})`);
	return parts.join(' ');
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const totalSize = (files: readonly SkillFile[]) => files.reduce((n, f) => n + f.size, 0);

/** A managed skill other desktops can fetch at the same commit (a remote git origin). */
export function isTeamShareable(s: SkillInfo): boolean {
	const o = s.origin;
	if (s.source !== 'managed' || s.error || !o || o.kind !== 'git' || !o.url || !o.commit || !/^[0-9a-f]{40}$/.test(o.commit)) return false;
	return !o.url.startsWith('/') && !/^file:/i.test(o.url);
}

/** Whether `items` holds a link the Skills view can install (what the install box hints). */
export function looksInstallable(text: string): boolean {
	const v = text.trim();
	return /^https:\/\/\S+$/i.test(v) || /^ssh:\/\/\S+$/i.test(v) || /^[\w.-]+@[\w.-]+:\S+$/.test(v) || /^file:\/\/\/\S+$/i.test(v) || v.startsWith('/');
}

export type TeamSkillState = 'match' | 'different' | 'missing';

/** A shared skill against the managed skill of that name here. */
export function teamSkillState(entry: TeamSkill, list: readonly SkillInfo[]): TeamSkillState {
	const here = list.find((s) => s.source === 'managed' && s.name === entry.skill_name);
	if (!here) return 'missing';
	return here.origin?.hash === entry.content_sha256 && here.origin?.commit === entry.commit_sha ? 'match' : 'different';
}

/** The sharer and owners/leads may replace or remove a shared skill. */
export const canUnshare = (entry: TeamSkill, userId: string | undefined, role: string | undefined) => entry.shared_by === userId || role === 'owner' || role === 'lead';

/** The candidate the review starts on: the only one, else the first installable one. */
export const firstCandidate = (p: PreparedSkills): SkillCandidate | undefined => p.candidates.find((c) => !c.error) ?? p.candidates[0];
