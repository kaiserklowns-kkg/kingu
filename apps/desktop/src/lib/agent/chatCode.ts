// Code blocks of a response (VS Code's codeBlockPart / chatCodeblockActions): the fence's
// language as a Monaco language id, and the text Insert into Terminal types. Pure, so `bun test`
// covers it.

export type LanguageInfo = { id: string; aliases?: string[]; extensions?: string[] };

/** Fence names that are not a language's id, alias or extension. */
const FENCE_ALIASES: Record<string, string> = {
	sh: 'shell',
	bash: 'shell',
	zsh: 'shell',
	console: 'shell',
	shellscript: 'shell',
	js: 'javascript',
	ts: 'typescript',
	jsx: 'javascriptreact',
	tsx: 'typescriptreact',
	py: 'python',
	rs: 'rust',
	yml: 'yaml',
	md: 'markdown',
	golang: 'go',
	'c++': 'cpp',
	'c#': 'csharp',
	cs: 'csharp',
	kt: 'kotlin',
	rb: 'ruby',
	ps1: 'powershell',
	text: 'plaintext',
	txt: 'plaintext',
	plain: 'plaintext'
};

/** The language id of a code fence (```ts, ```Python, ```.rs): id, then alias, then extension; null when unknown. */
export function fenceLanguage(fence: string, languages: readonly LanguageInfo[]): string | null {
	const name = fence.trim().toLowerCase().replace(/^\./, '');
	if (!name) return null;
	const known = new Set(languages.map((l) => l.id));
	const mapped = FENCE_ALIASES[name];
	if (mapped && known.has(mapped)) return mapped;
	if (known.has(name)) return name;
	const byAlias = languages.find((l) => l.aliases?.some((a) => a.toLowerCase() === name));
	if (byAlias) return byAlias.id;
	const byExt = languages.find((l) => l.extensions?.some((e) => e.toLowerCase() === `.${name}`));
	return byExt?.id ?? null;
}

/**
 * What Insert into Terminal types: the code without its last line break, so nothing runs before
 * the user presses Enter. Several lines go in as one bracketed paste (the shell takes them as
 * typed text, not as commands to run one by one), like VS Code's `runCommand(code, false)`.
 */
export function terminalInput(code: string): string {
	const text = code.replace(/\r\n/g, '\n').replace(/\n+$/, '');
	return text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
}
