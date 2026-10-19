// Arkai's tool coach (old Kingu's Arkai: extensions/src/tool-coach.ts), for small local models
// that often shape a tool's arguments a little wrong and then do not know what to do with the
// error. Before a call runs, common slips are put right:
// - arguments that are not quite JSON (a code fence around them, trailing commas, one object
//   inside a JSON string);
// - the path under another name (`path`, `filepath`, `filename`, `file` for Read / Write / Edit,
//   whose parameter is `file_path`; `file_path`, `directory`, `dir` for Glob / Grep's `path`);
// - Edit's texts as `old_str` / `new_str` / `old_text` / `new_text`;
// - Write's `content` sent as a JSON-encoded string, decoded once (not for a .json file).
// After a call fails, the model gets one short hint on what to do next.

/** Every hint starts with this, so one is never added twice. */
export const HINT_PREFIX = '[Arkai hint]';

export const HINTS = {
	editTextNotFound: `${HINT_PREFIX} Re-read the file with Read and copy the exact text you want to replace, including whitespace and indentation, then retry the Edit.`,
	fileNotFound: `${HINT_PREFIX} Check the path: list the folder with Glob to find the right file, and use a path relative to the project folder.`,
	invalidArguments: `${HINT_PREFIX} Check the tool's parameter names and types in its definition and call it again; Read, Write and Edit take \`file_path\`.`
} as const;

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep']);
const FILE_ALIASES = ['path', 'filepath', 'filename', 'file', 'filePath'] as const;
const SEARCH_ALIASES = ['file_path', 'directory', 'dir', 'folder'] as const;
const EDIT_ALIASES: Record<string, string> = { old_str: 'old_string', new_str: 'new_string', old_text: 'old_string', new_text: 'new_string', oldString: 'old_string', newString: 'new_string' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The call's arguments as an object; an error message when they cannot be read as one. */
export function parseArguments(raw: string): { input: Obj } | { error: string } {
	const text = raw.trim();
	if (!text) return { input: {} };
	const tries = [
		text,
		// A code fence around the JSON.
		text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
		// Trailing commas.
		text.replace(/,\s*([}\]])/g, '$1')
	];
	for (const t of tries) {
		try {
			let v: unknown = JSON.parse(t);
			// One object sent as a JSON string.
			if (typeof v === 'string') v = JSON.parse(v);
			if (isObj(v)) return { input: v };
			return { error: 'Invalid arguments: expected a JSON object' };
		} catch {
			// Try the next repair.
		}
	}
	return { error: 'Invalid arguments: not valid JSON' };
}

/** A string that is itself a JSON string literal, decoded; undefined otherwise. */
export function unwrapJsonString(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === 'string' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The arguments with the common slips put right (the same object when there were none). */
export function coachInput(tool: string, input: Obj): Obj {
	const next: Obj = { ...input };
	let changed = false;
	const rename = (to: string, aliases: readonly string[]) => {
		if (typeof next[to] === 'string' && next[to] !== '') return;
		const alias = aliases.find((k) => typeof next[k] === 'string' && next[k] !== '');
		if (!alias) return;
		next[to] = next[alias];
		delete next[alias];
		changed = true;
	};
	if (FILE_TOOLS.has(tool)) rename('file_path', FILE_ALIASES);
	if (SEARCH_TOOLS.has(tool)) rename('path', SEARCH_ALIASES);
	if (tool === 'Edit') for (const [alias, to] of Object.entries(EDIT_ALIASES)) rename(to, [alias]);
	if (tool === 'Write' && typeof next.content === 'string' && !(typeof next.file_path === 'string' && /\.json$/i.test(next.file_path))) {
		const unwrapped = unwrapJsonString(next.content);
		if (unwrapped !== undefined) {
			next.content = unwrapped;
			changed = true;
		}
	}
	return changed ? next : input;
}

const FILE_NOT_FOUND = /ENOENT|no such file|file not found|does not exist|cannot find (the )?(file|path)/i;
const EDIT_TEXT_NOT_FOUND = /old_string was not found|not found in (the )?file|matches \d+ places|not unique/i;
const INVALID_ARGUMENTS = /invalid arguments|missing required|must be a|unknown tool/i;

/** The hint for a failed call, or undefined when none fits. */
export function hintFor(tool: string, error: string): string | undefined {
	if (error.includes(HINT_PREFIX)) return undefined;
	if (INVALID_ARGUMENTS.test(error)) return HINTS.invalidArguments;
	if (!FILE_TOOLS.has(tool) && !SEARCH_TOOLS.has(tool)) return undefined;
	if (FILE_NOT_FOUND.test(error)) return HINTS.fileNotFound;
	if (tool === 'Edit' && EDIT_TEXT_NOT_FOUND.test(error)) return HINTS.editTextNotFound;
	return undefined;
}
