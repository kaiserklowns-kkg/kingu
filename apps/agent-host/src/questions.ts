// AskUserQuestion: Claude asks the user 1-4 multiple-choice questions through a tool call.
//
// The SDK routes it through `canUseTool` like any tool, but "allow" alone answers nothing: the
// answers travel back in `updatedInput.answers` (sdk-tools.d.ts `AskUserQuestionInput.answers`,
// "User answers collected by the permission component"), keyed by each question's text, with a
// multi-select answer comma-separated (`AskUserQuestionOutput.answers`). Free text the user types
// instead of an option is that question's answer string. Orca does the same
// (claude-structured-prompt-replies.ts: `updatedInput: { ...prompt.input, answers }`).

export const ASK_USER_QUESTION = 'AskUserQuestion';

/** Told to Claude when the user closes the questions without answering (Orca's wording). */
export const QUESTIONS_DISMISSED = 'The user dismissed these questions without answering. End your turn and wait for them.';

export const isAskUserQuestion = (tool: string) => tool === ASK_USER_QUESTION;

/** The question texts of an AskUserQuestion input, in order (empty when it has none). */
export function questionTexts(input: unknown): string[] {
	const qs = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined;
	if (!Array.isArray(qs)) return [];
	return qs.map((q) => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : ''));
}

/**
 * Checks the user's answers against the questions asked: one non-empty answer per question,
 * nothing else. Returns the map to put in `updatedInput.answers`, or throws with why not.
 */
export function checkAnswers(input: unknown, answers: unknown): Record<string, string> {
	const texts = questionTexts(input);
	if (!texts.length || texts.some((t) => !t)) throw new Error('AskUserQuestion input has no questions');
	if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('answers must map each question to its answer');
	const given = answers as Record<string, unknown>;
	for (const key of Object.keys(given)) if (!texts.includes(key)) throw new Error(`answer for a question that was not asked: ${key}`);
	const out: Record<string, string> = {};
	for (const t of texts) {
		const a = given[t];
		if (typeof a !== 'string' || !a.trim()) throw new Error(`no answer for: ${t}`);
		out[t] = a.trim();
	}
	return out;
}
