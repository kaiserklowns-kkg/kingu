// Terminal Quick Fixes (VS Code's built-in ones, `terminal.integrated.shellIntegration.quickFixEnabled`):
// a finished command's line and output suggest what to run next. Pure.

export type QuickFix =
	/** Type `command` into the shell and run it. */
	| { kind: 'run'; command: string; label: { key: QuickFixLabel; params: Record<string, string> } }
	/** Open a web page (a pull request link git printed). */
	| { kind: 'open'; url: string; label: { key: QuickFixLabel; params: Record<string, string> } };

export type QuickFixLabel = 'freePort' | 'setUpstream' | 'gitSimilar' | 'openPr';

/** The output git or a server printed is read up to this many characters from its end. */
const MAX_OUTPUT = 8000;

/** A shell-safe word (a branch or remote name git printed). */
const safeWord = (s: string) => /^[\w./@+-]+$/.test(s);

/** The kill command freeing TCP `port` (macOS and Linux both have lsof). */
export const freePortCommand = (port: string) => `kill $(lsof -t -i tcp:${port})`;

export function quickFixes(command: string, output: string, exitCode: number | undefined): QuickFix[] {
	const text = output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output;
	const cmd = command.trim();
	const out: QuickFix[] = [];
	const ok = exitCode === 0;

	// A port already in use (Node's EADDRINUSE, Python's "Address already in use", …): free it and run again.
	if (!ok) {
		const port =
			/EADDRINUSE[^\n]*?:(\d{2,5})\b/.exec(text)?.[1] ??
			/(?:address|port)[^\n]{0,40}?\b(\d{2,5})\b[^\n]{0,40}?(?:already in use|in use)/i.exec(text)?.[1] ??
			/(?:already in use|in use)[^\n]{0,40}?(?:port|:)\s*(\d{2,5})\b/i.exec(text)?.[1];
		if (port && Number(port) > 0 && Number(port) < 65536)
			out.push({ kind: 'run', command: cmd ? `${freePortCommand(port)} && ${cmd}` : freePortCommand(port), label: { key: 'freePort', params: { port } } });
	}

	if (/^git(\s|$)/.test(cmd)) {
		// `git push` on a branch without an upstream: git prints the command to run.
		const upstream = /git push --set-upstream (\S+) (\S+)/.exec(text);
		if (!ok && upstream && safeWord(upstream[1]) && safeWord(upstream[2])) {
			out.push({ kind: 'run', command: `git push --set-upstream ${upstream[1]} ${upstream[2]}`, label: { key: 'setUpstream', params: { remote: upstream[1], branch: upstream[2] } } });
		}
		// `git stauts`: git names the similar command(s).
		const typo = /git: '([^']+)' is not a git command/.exec(text);
		if (!ok && typo) {
			const after = text.slice(text.indexOf('The most similar command'));
			const similar = /The most similar commands? (?:is|are)\s*\n((?:\s+\S+\n?)+)/.exec(after)?.[1] ?? '';
			for (const name of similar.split(/\s+/).filter((s) => s && safeWord(s))) {
				const fixed = cmd.replace(new RegExp(`^git(\\s+)${typo[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), `git$1${name}`);
				if (fixed !== cmd) out.push({ kind: 'run', command: fixed, label: { key: 'gitSimilar', params: { command: fixed } } });
			}
		}
		// A push that printed where to open a pull request.
		const pr = /(?:Create a pull request|create a merge request|Create pull request)[^\n]*\n(?:remote:\s*)?\s*(https?:\/\/\S+)/i.exec(text);
		if (pr) out.push({ kind: 'open', url: pr[1], label: { key: 'openPr', params: { url: pr[1] } } });
	}
	return out;
}
