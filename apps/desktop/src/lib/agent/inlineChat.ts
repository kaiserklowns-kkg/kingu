// Inline chat (VS Code's editor inline chat ⌘I and terminal inline chat ⌘I), the pure part so
// `bun test` covers it: the one-shot prompt sent to the source-control AI agent (Rust
// agent/ai_text.rs `ai_generate`, the CLI the user set up in kingu.git.ai.agent) and reading the
// code or command back out of its answer.

/** Lines of code around the selection that go with the request. */
export const CONTEXT_LINES = 60;

export type EditorAsk = {
	instruction: string;
	path: string;
	language: string;
	/** The file's lines (1-based) `before` the selection, the selected text, and the lines after. */
	before: string;
	selection: string;
	after: string;
};

/** The editor request: rewrite the selection (or write code at the cursor when it is empty). */
export function editorPrompt(a: EditorAsk): string {
	const target = a.selection
		? `Rewrite the SELECTED code below as the instruction says. Reply with only the new code for the selection, in one fenced code block: no explanation, keep the indentation of the surroundings.`
		: `Write the code the instruction asks for, to insert at the CURSOR below. Reply with only that code, in one fenced code block: no explanation, indent it for where it goes.`;
	return [
		`You are an inline code editor in the file ${a.path} (${a.language}). Do not run tools or change any file; answer only with text.`,
		target,
		`Instruction: ${a.instruction}`,
		'',
		'<before>',
		a.before,
		'</before>',
		a.selection ? `<selection>\n${a.selection}\n</selection>` : '<cursor/>',
		'<after>',
		a.after,
		'</after>'
	].join('\n');
}

/** The terminal request: one shell command for the user's shell. */
export function terminalPrompt(instruction: string, shell: string, platform: string, lastOutput: string): string {
	return [
		`You turn requests into ONE shell command for ${shell} on ${platform}. Do not run it or any tool; answer only with text.`,
		'Reply with only the command in one fenced code block (several commands joined with && when needed). No explanation.',
		`Request: ${instruction}`,
		...(lastOutput.trim() ? ['', 'The terminal shows (last command and its output):', lastOutput.slice(-4000)] : [])
	].join('\n');
}

/**
 * The code of an answer: its first fenced block (the language tag dropped), else the whole
 * answer trimmed. Trailing newlines go; the code's own indentation stays.
 */
export function codeFromAnswer(answer: string): string {
	const m = /```[^\n`]*\n([\s\S]*?)\n?```/.exec(answer);
	const code = m ? m[1] : answer.trim();
	return code.replace(/\s+$/, '');
}

/** A shell command from an answer: the code, a leading `$ ` prompt dropped, one line unless it needs several. */
export function commandFromAnswer(answer: string): string {
	return codeFromAnswer(answer)
		.split('\n')
		.map((l) => l.replace(/^\s*[$%]\s+/, ''))
		.filter((l) => l.trim() && !l.trim().startsWith('#'))
		.join('\n')
		.trim();
}

/** The lines of `text` around lines `start..end` (1-based): up to `n` before and after. */
export function around(text: string, start: number, end: number, n = CONTEXT_LINES): { before: string; after: string } {
	const lines = text.split('\n');
	return { before: lines.slice(Math.max(0, start - 1 - n), start - 1).join('\n'), after: lines.slice(end, end + n).join('\n') };
}
