// Source-control AI text (Orca's commit-message and PR-details generation): the prompts built from
// what Rust read (agent/ai_text.rs CommitContext / PrContext) and the agent's answer turned into
// a commit message or a PR title and body. Pure, so `bun test` covers it.

export type CommitContext = { branch: string | null; summary: string; patch: string };
export type PrContext = { branch: string | null; commits: string; summary: string; patch: string };

const MAX_INSTRUCTIONS = 4000;

const extra = (instructions: string | undefined) => {
	const t = (instructions ?? '').trim().slice(0, MAX_INSTRUCTIONS);
	return t ? ['', 'Additional instructions from the user:', t] : [];
};

const fenced = (patch: string, missing: string) => (patch.trim() ? ['```diff', patch.trimEnd(), '```'] : [missing]);

/** The commit-message prompt: staged files and patch, the message format, then the user's instructions. */
export function commitPrompt(ctx: CommitContext, instructions?: string): string {
	return [
		'Write one git commit message for the staged changes below.',
		'Reply with the message only: no preamble, quotes or code fences.',
		'Format: a subject line in the imperative mood, at most 72 characters, without a trailing period;',
		'optionally a blank line and a short body saying why the change was made. No trailers such as Co-authored-by.',
		'',
		`Branch: ${ctx.branch ?? '(detached HEAD)'}`,
		'',
		'Staged files:',
		ctx.summary.trim() || '(none)',
		'',
		'Staged changes:',
		...fenced(ctx.patch, '(the patch is not included; go by the file list)'),
		...extra(instructions)
	].join('\n');
}

/** The PR-details prompt: the branch's commits and changes, the template to fill, then the user's instructions. */
export function prPrompt(ctx: PrContext, base: string, template: string | null, instructions?: string): string {
	return [
		`Write the title and description of a pull request that merges ${ctx.branch ?? 'this branch'} into ${base}.`,
		'Reply in exactly this shape and nothing else: the title on the first line (at most 72 characters, no trailing period),',
		'a blank line, then the description in Markdown. No preamble and no code fence around the whole reply.',
		...(template?.trim() ? ['', "Fill in the repository's pull request template for the description:", template.trim()] : []),
		'',
		'Commits:',
		ctx.commits.trim() || '(none)',
		'',
		'Changed files:',
		ctx.summary.trim() || '(none)',
		'',
		'Changes:',
		...fenced(ctx.patch, '(the patch is not included; go by the commits and files)'),
		...extra(instructions)
	].join('\n');
}

/** The agent's answer without a wrapping code fence, surrounding quotes or a "Commit message:" label. */
export function cleanAnswer(text: string): string {
	let t = text.replace(/\r\n/g, '\n').trim();
	const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
	if (fence) t = fence[1].trim();
	t = t.replace(/^(?:commit message|message|title)\s*:\s*/i, '');
	if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
	return t;
}

/** A commit message: the subject trimmed to 72 characters without a trailing period, a blank line, the body. */
export function commitMessage(answer: string): string {
	const t = cleanAnswer(answer);
	const nl = t.indexOf('\n');
	const subject = (nl < 0 ? t : t.slice(0, nl)).trim().replace(/\.+$/, '').slice(0, 72).trimEnd();
	const body = nl < 0 ? '' : t.slice(nl + 1).trim();
	if (!subject) return '';
	return body ? `${subject}\n\n${body}` : subject;
}

/** A PR title (first line, `#`/`Title:` stripped) and description (the rest). Null when there is no title. */
export function prDetails(answer: string): { title: string; body: string } | null {
	const t = cleanAnswer(answer);
	const nl = t.indexOf('\n');
	const title = (nl < 0 ? t : t.slice(0, nl))
		.trim()
		.replace(/^#+\s*/, '')
		.replace(/^title\s*:\s*/i, '')
		.replace(/\.+$/, '')
		.slice(0, 120)
		.trim();
	if (!title) return null;
	return { title, body: nl < 0 ? '' : t.slice(nl + 1).trim() };
}
