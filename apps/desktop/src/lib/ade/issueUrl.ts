// An issue URL typed or pasted into the New Task name field (Orca's smart workspace name field):
// which tracker it names and the reference its API needs. Pure; the lookup is issueUrlLookup.ts.
//
// Shapes, from Orca's source: GitHub `/<owner>/<repo>/issues/<n>` on any host
// (shared/github/repositories/links.ts), GitLab `/<group…>/<project>/-/issues|work_items/<n>` on any
// host (shared/new-workspace/gitlab-links.ts), Jira `…/browse/<KEY-1>` (shared/jira/jira-issue-url.ts)
// and Linear `linear.app/<team>/issue/<KEY-1>` (shared/linear/links.ts). Pull and merge requests are
// not issues here: the form's own "Pull request" source starts from those.

export type IssueUrl =
	| { provider: 'github'; url: string; host: string; repo: string; number: number }
	| { provider: 'gitlab'; url: string; host: string; project: string; number: number }
	| { provider: 'jira'; url: string; host: string; key: string; number: number }
	| { provider: 'linear'; url: string; key: string; number: number };

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-[1-9]\d*$/;
const LINEAR_KEY = /^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/;
const positive = (s: string): number | null => (/^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null);

/** The issue `text` names when it is nothing but an issue URL; null for a plain name or any other URL. */
export function parseIssueUrl(text: string): IssueUrl | null {
	const raw = text.trim();
	if (!/^https?:\/\/\S+$/i.test(raw)) return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.username || u.password) return null;
	const host = u.host.toLowerCase();
	const parts = u.pathname.split('/').filter(Boolean);

	const dash = parts.indexOf('-');
	if (dash >= 2 && (parts[dash + 1] === 'issues' || parts[dash + 1] === 'work_items')) {
		const number = positive(parts[dash + 2] ?? '');
		if (number === null) return null;
		const project = parts.slice(0, dash).join('/');
		return { provider: 'gitlab', url: `${u.protocol}//${host}/${project}/-/issues/${number}`, host, project, number };
	}
	if (host === 'linear.app') {
		if (parts.length < 3 || parts[1] !== 'issue' || !LINEAR_KEY.test(parts[2])) return null;
		const key = parts[2].toUpperCase();
		return { provider: 'linear', url: `https://linear.app/${parts[0]}/issue/${key}`, key, number: Number(key.split('-').pop()) };
	}
	const browse = parts.lastIndexOf('browse');
	if (browse >= 0 && browse === parts.length - 2 && JIRA_KEY.test(parts[browse + 1])) {
		const key = parts[browse + 1].toUpperCase();
		const prefix = parts.slice(0, browse).map((p) => `/${p}`).join('');
		return { provider: 'jira', url: `${u.protocol}//${host}${prefix}/browse/${key}`, host, key, number: Number(key.split('-').pop()) };
	}
	// `gh` reads https only, and its issue URL has no query or trailing path (Rust gh_projects::valid_issue_url).
	if (u.protocol === 'https:' && parts.length >= 4 && parts[2] === 'issues' && parts[1] !== '-') {
		const number = positive(parts[3]);
		if (number === null) return null;
		return { provider: 'github', url: `https://${host}/${parts[0]}/${parts[1]}/issues/${number}`, host, repo: `${parts[0]}/${parts[1]}`, number };
	}
	return null;
}

/** How the form names the issue before its title is known: `acme/app#12`, `ENG-123`. */
export function issueUrlRef(u: IssueUrl): string {
	return u.provider === 'github' ? `${u.repo}#${u.number}` : u.provider === 'gitlab' ? `${u.project}#${u.number}` : u.key;
}

/** The host of a configured site (`acme.atlassian.net`, `https://jira.acme.dev/`), lower case; '' when unreadable. */
export function siteHost(site: string): string {
	const s = site.trim();
	if (!s) return '';
	try {
		return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * The name field after an issue is linked (Orca workspace-source.ts): the issue's title takes the
 * field only when it is empty or still holds the pasted URL; a name the user typed stays.
 */
export function titleAfterLink(current: string, lookupText: string, issueTitle: string): string {
	const now = current.trim();
	return !now || now === lookupText.trim() ? issueTitle : current;
}
