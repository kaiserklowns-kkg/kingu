// Skills for the runtimes that cannot load a Claude plugin (Codex, ACP agents, Arkai). The app
// hands every run the same plugin folders (`plugins`: the Skills view's enabled skills, the active
// Snaps' skills and the `kingu` command's skill, each `<plugin>/skills/<name>/SKILL.md`, already
// filtered by the on/off switches in Rust). The Claude SDK loads them itself; the others get an
// index instead (name, description, path to SKILL.md) in their instructions, and the model reads a
// skill's SKILL.md with its own file tools when a task needs it. Nothing is written anywhere.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type SkillEntry = { name: string; description: string; path: string };

/** The few file calls this needs (tests pass a fake). */
export type SkillFs = {
	list: (dir: string) => string[];
	isFile: (path: string) => boolean;
	/** The first `max` bytes of a file as UTF-8. */
	head: (path: string, max: number) => string;
};

/** The index lists at most this many skills (the first ones: Kingu's own, the Skills view's, the Snaps'). */
export const MAX_SKILLS = 100;
/** A description is shortened past this many characters. */
export const MAX_DESCRIPTION = 300;
/** Only the front matter is read: the top of SKILL.md. */
const HEAD_BYTES = 16 * 1024;
const SKILL_FILE = 'SKILL.md';

const nodeFs: SkillFs = {
	list: (dir) => readdirSync(dir),
	isFile: (path) => statSync(path).isFile(),
	head: (path, max) => {
		const fd = openSync(path, 'r');
		try {
			const buf = Buffer.alloc(max);
			const n = readSync(fd, buf, 0, max, 0);
			return buf.subarray(0, n).toString('utf8');
		} finally {
			closeSync(fd);
		}
	}
};

/** `name` and `description` from SKILL.md's YAML front matter (plain, quoted or `>` / `|` block values). */
export function frontMatter(text: string): { name?: string; description?: string } {
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return {};
	const out: Record<string, string> = {};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === '---') break;
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		const [, key, raw] = m as unknown as [string, string, string];
		let value = raw.trim();
		// A quoted value may go on over the next lines until its closing quote.
		const q = value[0];
		if ((q === '"' || q === "'") && (value.length < 2 || !value.endsWith(q))) {
			while (i + 1 < lines.length && lines[i + 1]!.trim() !== '---' && !value.endsWith(q)) value += ' ' + lines[++i]!.trim();
		}
		if (/^[>|][+-]?$/.test(value)) {
			// A block value: the indented lines after it.
			const block: string[] = [];
			while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) block.push(lines[++i]!.trim());
			value = value.startsWith('|') ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
		} else if (/^(["']).*\1$/.test(value) && value.length >= 2) {
			const q = value[0];
			value = value.slice(1, -1);
			value = q === '"' ? value.replace(/\\(["\\])/g, '$1').replace(/\\n/g, ' ') : value.replace(/''/g, "'");
		} else {
			// A plain value may go on over indented lines.
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !/^\s*[A-Za-z_][\w-]*:\s/.test(lines[i + 1]!)) value += ' ' + lines[++i]!.trim();
		}
		if (key === 'name' || key === 'description') out[key] = value;
	}
	return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const shorten = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * The skills in these plugin folders, in order; a name seen before is skipped. Unreadable folders
 * and files are skipped too: a run starts without them rather than failing.
 */
export function readSkills(pluginDirs: readonly string[], fs: SkillFs = nodeFs): SkillEntry[] {
	const out: SkillEntry[] = [];
	const seen = new Set<string>();
	for (const plugin of pluginDirs) {
		const base = join(plugin, 'skills');
		let folders: string[];
		try {
			folders = fs.list(base).filter((f) => !f.startsWith('.')).sort();
		} catch {
			continue;
		}
		for (const folder of folders) {
			if (out.length >= MAX_SKILLS) return out;
			const path = join(base, folder, SKILL_FILE);
			let text: string;
			try {
				if (!fs.isFile(path)) continue;
				text = fs.head(path, HEAD_BYTES);
			} catch {
				continue;
			}
			const front = frontMatter(text);
			const name = oneLine(front.name || folder);
			if (!name || seen.has(name)) continue;
			seen.add(name);
			out.push({ name, description: shorten(oneLine(front.description ?? ''), MAX_DESCRIPTION), path });
		}
	}
	return out;
}

/** The instructions text listing `skills`; '' when there are none. */
export function skillIndex(skills: readonly SkillEntry[]): string {
	if (!skills.length) return '';
	const rows = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}\n  ${s.path}`);
	return [
		'# Skills',
		'',
		'You have these skills: folders with instructions (and sometimes scripts or reference files) for particular tasks. When a task matches a skill\'s description, read its SKILL.md with your file-reading tool before you start, and follow it; paths in it are relative to the skill\'s folder. Do not read skills the task does not need.',
		'',
		...rows
	].join('\n');
}
