// Kingu's repetition check (from Arkai's repetition.ts, after goose's repetition inspector,
// crates/goose/src/tool_monitor.rs; Apache License 2.0, see NOTICE). A model can get stuck
// calling the same tool with the same arguments over and over: the same call is let through
// twice in a row, and from the third time on it is not run and the model is told to use the
// result it already has. The count starts over with each user message (`reset`), not each turn.

/** How many identical calls in a row may run; goose's `max_repetitions`. */
export const MAX_REPETITIONS = 2;

/** What the model is told instead of running the repeated call. */
export const REPETITION_REASON = "Kingu's safety check did not run this call: you already made this exact call twice in a row; use its result or change approach.";

/** JSON with object keys sorted at every level, so key order does not make two calls differ. */
export function stableStringify(value: unknown): string {
	if (value === undefined) return 'null';
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** The identity of a call: the tool and its arguments. */
export function stableKey(toolName: string, input: unknown): string {
	return `${toolName}\u0000${stableStringify(input)}`;
}

/** Counts identical calls in a row, like goose's `RepetitionInspector`. */
export class RepetitionTracker {
	#lastKey: string | undefined;
	#count = 0;

	constructor(readonly maxRepetitions = MAX_REPETITIONS) {}

	/** Records a call; false when it is one repeat too many and should not run. */
	check(toolName: string, input: unknown): boolean {
		const key = stableKey(toolName, input);
		this.#count = key === this.#lastKey ? this.#count + 1 : 1;
		this.#lastKey = key;
		return this.#count <= this.maxRepetitions;
	}

	/** How many times in a row the last call has been made. */
	get count(): number {
		return this.#count;
	}

	reset(): void {
		this.#lastKey = undefined;
		this.#count = 0;
	}
}
