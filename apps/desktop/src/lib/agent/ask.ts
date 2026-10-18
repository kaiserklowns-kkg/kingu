// Questions an agent asks the user (Claude's AskUserQuestion, codex's request_user_input, …):
// parsing their tool input, checking a choice is complete, and turning it into either
//   - the answers map the agent host puts in AskUserQuestion's `updatedInput.answers` (timeline), or
//   - keystrokes typed into the agent CLI's terminal (terminal mode's quick reply).
// The keystrokes follow Orca's native-chat-ask.ts `buildAskAnswerKeys` / `buildCodexAskAnswerKeys`,
// which Orca verified against the live TUIs. Pure.

export type AskOption = { label: string; description?: string };
export type AskQuestion = { question: string; header?: string; multiSelect: boolean; options: AskOption[] };
export type AskPrompt = { questions: AskQuestion[] };
/** One question's choice: picked option indices (any order) and/or the user's own words. */
export type AskSelection = { indices: number[]; other?: string };

/** The questions of a question tool's input (codex sends its arguments as a JSON string); null when it has none. */
export function parseAsk(input: unknown): AskPrompt | null {
	if (typeof input === 'string') {
		try {
			return parseAsk(JSON.parse(input));
		} catch {
			return null;
		}
	}
	const raw = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined;
	if (!Array.isArray(raw)) return null;
	const questions: AskQuestion[] = [];
	for (const q of raw) {
		if (!q || typeof q !== 'object') continue;
		const r = q as Record<string, unknown>;
		const options = (Array.isArray(r.options) ? r.options : []).flatMap((o): AskOption[] => {
			if (typeof o === 'string') return [{ label: o }];
			if (o && typeof o === 'object' && typeof (o as AskOption).label === 'string') {
				const { label, description } = o as AskOption;
				return [{ label, ...(typeof description === 'string' && description ? { description } : {}) }];
			}
			return [];
		});
		const question = typeof r.question === 'string' ? r.question : '';
		if (!question && !options.length) continue;
		questions.push({ question, ...(typeof r.header === 'string' && r.header ? { header: r.header } : {}), multiSelect: r.multiSelect === true || r.multiple === true, options });
	}
	return questions.length ? { questions } : null;
}

const otherOf = (sel: AskSelection | undefined) => (sel?.other ?? '').trim();

/** The picked labels (in option order) and then the user's own words. */
function answerParts(q: AskQuestion, sel: AskSelection | undefined): string[] {
	const labels = [...new Set(sel?.indices ?? [])]
		.sort((a, b) => a - b)
		.map((i) => q.options[i]?.label ?? '')
		.filter(Boolean);
	const other = otherOf(sel);
	return other ? [...labels, other] : labels;
}

/** A single-select takes one option or the user's own words; a multi-select any mix, but something. */
export function isAnswered(q: AskQuestion, sel: AskSelection | undefined): boolean {
	const picked = new Set(sel?.indices ?? []).size;
	const other = otherOf(sel) ? 1 : 0;
	return q.multiSelect ? picked + other > 0 : picked + other === 1;
}

/** Every question answered (Claude's AskUserQuestion wants an answer to each). */
export const isComplete = (prompt: AskPrompt, sels: readonly (AskSelection | undefined)[]) => prompt.questions.every((q, i) => isAnswered(q, sels[i]));

/**
 * The answers for `updatedInput.answers`: question text → the chosen label, labels joined by ", "
 * for a multi-select (the SDK's AskUserQuestionOutput format), or the user's own words.
 */
export function answersFor(prompt: AskPrompt, sels: readonly (AskSelection | undefined)[]): Record<string, string> {
	return Object.fromEntries(prompt.questions.map((q, i) => [q.question, answerParts(q, sels[i]).join(', ')]));
}

/** A keystroke group for the CLI's terminal: `raw` bytes as typed, `text` as a bracketed paste. */
export type AskKeyGroup = { raw: string } | { text: string };

const ENTER = '\r';
const NEXT_TAB = '\x1b[C';
const PREVIOUS_ROW = '\x1b[A';
const NEXT_ROW = '\x1b[B';
const NOTES = '\t';
const BACKSPACE = '\x7f';

/**
 * Claude Code's AskUserQuestion selector: an option's number picks it (a single-select commits and
 * moves on; a multi-select toggles), the row after the options is "Type something", → steps to
 * the next question or the Submit tab, which a multi-question (or lone multi-select) prompt ends
 * on. A bare Enter would commit the highlighted first option, so answers never rely on it.
 */
export function claudeAskKeys(prompt: AskPrompt, sels: readonly (AskSelection | undefined)[]): AskKeyGroup[] {
	const multiQuestion = prompt.questions.length > 1;
	const groups: AskKeyGroup[] = [];
	prompt.questions.forEach((q, qi) => {
		const sel = sels[qi];
		const other = otherOf(sel);
		const typeSomething = String(q.options.length + 1);
		if (q.multiSelect) {
			for (const i of [...new Set(sel?.indices ?? [])].sort((a, b) => a - b)) groups.push({ raw: String(i + 1) });
			if (other) groups.push({ raw: typeSomething }, { text: other }, { raw: ENTER });
			groups.push({ raw: NEXT_TAB });
		} else if (other) {
			groups.push({ raw: typeSomething }, { text: answerParts(q, sel).join(', ') }, { raw: ENTER });
		} else if (sel?.indices.length) {
			groups.push({ raw: String(sel.indices[0] + 1) });
		} else if (multiQuestion) {
			groups.push({ raw: NEXT_TAB });
		}
	});
	if ((multiQuestion || prompt.questions[0]?.multiSelect) && groups.length) groups.push({ raw: ENTER });
	return groups;
}

/** codex's request_user_input overlay: the option digit submits; own words go in as notes on a row. */
export function codexAskKeys(prompt: AskPrompt, sels: readonly (AskSelection | undefined)[]): AskKeyGroup[] {
	const groups: AskKeyGroup[] = [];
	let skipped = false;
	prompt.questions.forEach((q, qi) => {
		const sel = sels[qi];
		const picked = sel?.indices[0];
		const note = otherOf(sel);
		if (note) {
			const target = picked ?? q.options.length;
			const rows = q.options.length + 1;
			const back = rows - target < target;
			for (let n = back ? rows - target : target; n > 0; n--) groups.push({ raw: back ? PREVIOUS_ROW : NEXT_ROW });
			groups.push({ raw: NOTES }, { text: note }, { raw: ENTER });
		} else if (picked !== undefined) {
			groups.push({ raw: String(picked + 1) });
		} else {
			skipped = true;
			groups.push({ raw: BACKSPACE }, { raw: qi < prompt.questions.length - 1 ? NEXT_TAB : ENTER });
		}
	});
	if (skipped) groups.push({ raw: ENTER });
	return groups;
}

/** Other CLIs: each question's answer pasted as a line of text and submitted. */
export function textAskKeys(prompt: AskPrompt, sels: readonly (AskSelection | undefined)[]): AskKeyGroup[] {
	return prompt.questions.flatMap((q, i): AskKeyGroup[] => [{ text: answerParts(q, sels[i]).join(', ') }, { raw: ENTER }]);
}

/** The keystrokes that answer `prompt` in the terminal of CLI `cli` (an agent profile id). */
export function askKeysFor(cli: string, prompt: AskPrompt, sels: readonly (AskSelection | undefined)[]): AskKeyGroup[] {
	if (cli === 'claude') return claudeAskKeys(prompt, sels);
	if (cli === 'codex') return codexAskKeys(prompt, sels);
	return textAskKeys(prompt, sels);
}

/** Between keystroke groups: the selector must apply one before the next (Orca's 500 + 500 ms step). */
export const ASK_KEY_STEP_MS = 1000;

/**
 * Types the groups one step apart. `live()` is asked before each write and stops the typing once
 * false (the task's CLI was restarted or ended: never type into another terminal). True when all went.
 */
export async function typeAskKeys(
	groups: readonly AskKeyGroup[],
	io: { write: (data: string) => Promise<unknown>; paste: (text: string) => string; wait: (ms: number) => Promise<unknown>; live: () => boolean }
): Promise<boolean> {
	for (const [i, g] of groups.entries()) {
		if (i) await io.wait(ASK_KEY_STEP_MS);
		if (!io.live()) return false;
		await io.write('raw' in g ? g.raw : io.paste(g.text));
	}
	return true;
}
