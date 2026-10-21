// Agent status from a terminal's title (OSC 0/2), for CLIs without hooks and as corroboration
// for those with them: a port of Orca's agent-title-core / agent-title-status (claude's ✳ and
// spinner frames, gemini's glyphs, opencode's `OC |` title, an agent name with a status word).
// A plain shell title (`zsh`, `user@host: ~/repo`) is no agent. Pure, so `bun test` covers it.

export type TitleStatus = 'working' | 'permission' | 'idle';

const CLAUDE_IDLE = '✳'; // ✳
const GEMINI_WORKING = '✦'; // ✦
const GEMINI_SILENT_WORKING = '⏲'; // ⏲
const GEMINI_IDLE = '◇'; // ◇
const GEMINI_PERMISSION = '✋'; // ✋

/** Agent names Orca matches in titles (short ones like `amp` would match ordinary words). */
export const AGENT_NAMES = ['claude', 'openclaude', 'codex', 'copilot', 'cursor', 'gemini', 'antigravity', 'opencode', 'mimo', 'openclaw', 'aider', 'grok', 'devin', 'droid', 'hermes', 'agy', 'qwen'];

// Whole tokens only: `~/codex/ready`, `opencode-blinker` and `android` are not agents.
const token = (name: string) => `(?<![\\w./\\\\-])${name}(?:\\.(?:exe|cmd|bat|ps1))?(?![\\w./\\\\-])`;
const AGENT_NAME_RE = new RegExp(token(`(${AGENT_NAMES.join('|')})`), 'i');
const IDLE_WORD_RE = new RegExp(token('(?:ready|idle|done)'), 'i');
const WORKING_WORD_RE = new RegExp(token('(?:working|thinking|running)'), 'i');
const CLAUDE_MANAGEMENT_RE = /^\s*["']?(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?["']?\s+agents\s*$/i;
const OPENCODE_RE = /^\s*(?:(?![▣⠀-⣿])[^|]+? \| )?(?:[▣⠀-⣿] )?OC \|[ \t]+\S/u;

/** Braille spinner frames, and the quarter circles Claude Code 2.1.228+ animates instead. */
export function hasSpinner(title: string): boolean {
	for (const c of title) {
		const p = c.codePointAt(0) ?? 0;
		if ((p >= 0x2800 && p <= 0x28ff) || (p >= 0x25d0 && p <= 0x25d3)) return true;
	}
	return false;
}

/** The agent a title names, lower case (`claude`, `gemini`, …), or null. */
export function titleAgent(title: string): string | null {
	if (!title) return null;
	if (title.startsWith(CLAUDE_IDLE)) return 'claude';
	if ([GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION].some((g) => title.includes(g))) return 'gemini';
	if (OPENCODE_RE.test(title)) return 'opencode';
	return AGENT_NAME_RE.exec(title)?.[1]?.toLowerCase() ?? null;
}

/** Orca's detectAgentStatusFromTitle: working, waiting on a permission answer, idle, or no agent (null). */
export function titleStatus(title: string): TitleStatus | null {
	if (!title || CLAUDE_MANAGEMENT_RE.test(title)) return null;
	// cursor-agent's bare title is identity only; its hooks carry the state.
	if (title.trim().toLowerCase() === 'cursor agent') return null;
	if (OPENCODE_RE.test(title)) return hasSpinner(title) ? 'working' : 'idle';
	if (title.includes(GEMINI_PERMISSION)) return 'permission';
	if (title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING)) return 'working';
	if (title.includes(GEMINI_IDLE)) return 'idle';
	if (title === CLAUDE_IDLE || title.startsWith(`${CLAUDE_IDLE} `)) return 'idle';
	if (hasSpinner(title)) return 'working';
	if (!AGENT_NAME_RE.test(title)) return null;
	const lower = title.toLowerCase();
	if (['action required', 'permission', 'waiting'].some((w) => lower.includes(w))) return 'permission';
	if (IDLE_WORD_RE.test(title)) return 'idle';
	if (WORKING_WORD_RE.test(title)) return 'working';
	if (title.startsWith('. ')) return 'working';
	if (title.startsWith('* ')) return 'idle';
	// droid's name-only title says nothing (its hooks do).
	if (titleAgent(title) === 'droid') return null;
	return 'idle';
}

/**
 * A terminal's title as status evidence (Orca's createAgentStatusTracker): the latest status the
 * title gave, and `exited` once a title of no agent follows an idle or permission one (the CLI
 * quit back to the shell). A title of no agent while working is a transient frame and is ignored.
 */
export type TitleTrack = { title: string; status: TitleStatus | null; agent: string | null; exited: boolean; at: number };

export function applyTitle(prev: TitleTrack | undefined, title: string, now: number): TitleTrack {
	const status = titleStatus(title);
	if (status !== null) return { title, status, agent: titleAgent(title) ?? prev?.agent ?? null, exited: false, at: status === prev?.status ? prev.at : now };
	if (prev?.status && prev.status !== 'working') return { title, status: null, agent: null, exited: true, at: now };
	if (prev?.status === 'working') return { ...prev, title };
	return { title, status: null, agent: null, exited: prev?.exited ?? false, at: prev?.at ?? now };
}
