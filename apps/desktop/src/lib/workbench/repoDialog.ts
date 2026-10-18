// Pure parts of the Clone Repository / New Project dialog (Orca's Add Project: clone and create
// steps). Rust validates again (`CloneUrl::parse`, `project::create`); this only gives feedback
// while typing. Free of runes so `bun test` covers it.

/** Why `input` cannot be cloned, or null. https, ssh and `user@host:path` only, as Rust allows. */
export function cloneUrlError(input: string): string | null {
	const url = input.trim();
	if (!url) return 'ใส่ URL ของ repository';
	const usage = 'ใช้ https://…, ssh://… หรือ git@host:owner/repo.git';
	if (/\s/.test(url) || url.startsWith('-') || url.includes('#')) return `URL ไม่ถูกต้อง: ${usage}`;
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (scheme) {
		const s = scheme[1].toLowerCase();
		if (s !== 'https' && s !== 'ssh') return `ไม่รองรับ ${s}:// ${usage}`;
		const host = url.slice(scheme[0].length).split('/')[0].split('@').pop() ?? '';
		if (!host || host.startsWith('-') || !url.slice(scheme[0].length).includes('/')) return `URL ไม่ถูกต้อง: ${usage}`;
		return null;
	}
	if (url.includes('::')) return `URL ไม่ถูกต้อง: ${usage}`;
	const scp = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+):(.+)$/.exec(url);
	if (scp && !scp[2].startsWith('-') && !(scp[1] ?? '').startsWith('-')) return null;
	return `URL ไม่ถูกต้อง: ${usage}`;
}

/** The folder git clones into: the URL's last segment without `.git` (Orca's rule). */
export function repoNameFromUrl(input: string): string {
	const source = input.trim().replace(/\/+$/, '').replace(/\.git$/, '');
	const name = source.split(/[/:]/).pop() ?? '';
	return name === '.' || name === '..' ? '' : name;
}

/** Why `name` cannot be a project folder name, or null (Orca's create step rules). */
export function projectNameError(name: string): string | null {
	const n = name.trim();
	if (!n) return 'ใส่ชื่อโปรเจกต์';
	if (/[\\/]/.test(n) || n === '.' || n === '..') return 'ชื่อห้ามมี / และห้ามเป็น . หรือ ..';
	if (n.startsWith('-')) return 'ชื่อห้ามขึ้นต้นด้วย -';
	return null;
}

/** Orca's defaults: clones beside the worktrees folder (`~/kingu`), new projects in `~/kingu/projects`. */
export function defaultParents(home: string): { clone: string; project: string } {
	const h = home.replace(/\/+$/, '');
	return { clone: `${h}/kingu`, project: `${h}/kingu/projects` };
}

export type CloneProgress = { phase: string; percent: number };

/** `Receiving objects 42%`. */
export function progressLabel(p: CloneProgress | null): string {
	return p ? `${p.phase} ${p.percent}%` : 'กำลังเริ่ม clone…';
}
