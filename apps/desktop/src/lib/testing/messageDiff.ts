// The failure peek's diff of an assertion's expected and actual values (VS Code shows them in a
// diff editor in the test output peek): expected is the original side, actual the modified one,
// as a unified list of lines. Pure; the line matching is Source Control's (scm/lineDiff.ts).

import { diffLines } from '#lib/scm/lineDiff.ts';

export type MessageDiffLine = { kind: 'ctx' | 'expected' | 'actual'; text: string };

const lines = (s: string) => s.replace(/\r\n/g, '\n').split('\n');

export function messageDiff(expected: string, actual: string): MessageDiffLine[] {
	const exp = lines(expected);
	const act = lines(actual);
	const out: MessageDiffLine[] = [];
	let o = 1;
	for (const c of diffLines(exp, act)) {
		// An insertion names the expected line it follows; a deletion's actual side is empty.
		const oStart = c.originalEndLineNumber === 0 ? c.originalStartLineNumber + 1 : c.originalStartLineNumber;
		for (; o < oStart; o++) out.push({ kind: 'ctx', text: exp[o - 1] });
		if (c.originalEndLineNumber > 0) {
			for (let i = c.originalStartLineNumber; i <= c.originalEndLineNumber; i++) out.push({ kind: 'expected', text: exp[i - 1] });
			o = c.originalEndLineNumber + 1;
		}
		if (c.modifiedEndLineNumber > 0) for (let j = c.modifiedStartLineNumber; j <= c.modifiedEndLineNumber; j++) out.push({ kind: 'actual', text: act[j - 1] });
	}
	for (; o <= exp.length; o++) out.push({ kind: 'ctx', text: exp[o - 1] });
	return out;
}

/** Whether the values are worth a diff (both known and different). */
export const hasDiff = (expected: string | undefined, actual: string | undefined): expected is string => expected !== undefined && actual !== undefined && expected !== actual;
