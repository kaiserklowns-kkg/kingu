// Shell integration sequences (VS Code's docs/terminal/shell-integration.md): VS Code's OSC 633,
// Final Term's OSC 133, OSC 7 and iTerm2's OSC 1337 CurrentDir / SetMark, turned into events for
// the command tracker (commandTracker.ts). Kingu's scripts (src-tauri/shell-integration/) send
// OSC 633; a prompt theme or another tool may send the others. Pure.

export type ShellEvent =
	/** A: the prompt starts. */
	| { type: 'promptStart' }
	/** B: the prompt ends, the command line is typed after it. */
	| { type: 'commandStart' }
	/** C: the command runs; its output follows. */
	| { type: 'executed' }
	/** D: the command finished (no code: nothing ran, or the shell did not say). */
	| { type: 'finished'; exitCode?: number }
	/** E: the exact command line the shell ran. */
	| { type: 'commandLine'; command: string; nonce?: string }
	/** P;Cwd=, OSC 7, OSC 1337 CurrentDir=: the shell's current directory. */
	| { type: 'cwd'; cwd: string }
	/** P;<key>=<value> other than Cwd (IsWindows, HasRichCommandDetection, Kingu's Shell). */
	| { type: 'property'; key: string; value: string }
	/** OSC 1337 SetMark: a mark on the current line. */
	| { type: 'mark' };

/** A 633 value: `\\` is a backslash and `\xHH` a character code; anything else stays as is. */
export function unescapeValue(value: string): string {
	return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, esc: string, hex?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : esc));
}

function exitCode(raw: string | undefined): number | undefined {
	if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return undefined;
	return Number(raw.trim());
}

/** OSC 633 (`data` is what follows `633;`). */
export function parseOsc633(data: string): ShellEvent | null {
	const [kind, ...rest] = data.split(';');
	switch (kind) {
		case 'A':
			return { type: 'promptStart' };
		case 'B':
			return { type: 'commandStart' };
		case 'C':
			return { type: 'executed' };
		case 'D':
			return { type: 'finished', exitCode: exitCode(rest[0]) };
		case 'E': {
			if (rest.length === 0) return null;
			// The command line escapes `;`, so a raw one separates the nonce.
			const nonce = rest.length > 1 ? rest[rest.length - 1] : undefined;
			const command = unescapeValue(rest.length > 1 ? rest.slice(0, -1).join(';') : rest[0]);
			return nonce === undefined ? { type: 'commandLine', command } : { type: 'commandLine', command, nonce };
		}
		case 'P': {
			const prop = rest.join(';');
			const eq = prop.indexOf('=');
			if (eq <= 0) return null;
			const key = prop.slice(0, eq);
			const value = unescapeValue(prop.slice(eq + 1));
			if (key === 'Cwd') return value ? { type: 'cwd', cwd: value } : null;
			return { type: 'property', key, value };
		}
		default:
			return null;
	}
}

/** OSC 133 (Final Term): A, B, C, D[;exit code]; options after the kind (`;aid=…`) are ignored. */
export function parseOsc133(data: string): ShellEvent | null {
	const [kind, ...rest] = data.split(';');
	switch (kind) {
		case 'A':
			return { type: 'promptStart' };
		case 'B':
			return { type: 'commandStart' };
		case 'C':
			return { type: 'executed' };
		case 'D':
			return { type: 'finished', exitCode: exitCode(rest.find((r) => !r.includes('='))) };
		default:
			return null;
	}
}

/** OSC 7: `file://host/path` (percent-encoded) or `kitty-shell-cwd://host/path`. */
export function parseOsc7(data: string): ShellEvent | null {
	const m = /^(?:file|kitty-shell-cwd):\/\/[^/]*(\/.*)$/.exec(data.trim());
	if (!m) return null;
	let path: string;
	try {
		path = decodeURIComponent(m[1]);
	} catch {
		path = m[1];
	}
	return { type: 'cwd', cwd: path };
}

/** OSC 1337 (iTerm2): `CurrentDir=<dir>` and `SetMark`; the rest is not shell integration. */
export function parseOsc1337(data: string): ShellEvent | null {
	if (data === 'SetMark') return { type: 'mark' };
	if (data.startsWith('CurrentDir=')) {
		const cwd = data.slice('CurrentDir='.length);
		return cwd ? { type: 'cwd', cwd } : null;
	}
	return null;
}

/** The OSC numbers shell integration listens to, with their parsers. */
export const SHELL_INTEGRATION_OSCS: readonly [number, (data: string) => ShellEvent | null][] = [
	[633, parseOsc633],
	[133, parseOsc133],
	[7, parseOsc7],
	[1337, parseOsc1337]
];

/** `terminal.integrated.shellIntegration.decorationsEnabled`: where command decorations show. */
export function decorationPlaces(setting: string | undefined): { gutter: boolean; ruler: boolean } {
	switch (setting) {
		case 'never':
			return { gutter: false, ruler: false };
		case 'gutter':
			return { gutter: true, ruler: false };
		case 'overviewRuler':
			return { gutter: false, ruler: true };
		default:
			return { gutter: true, ruler: true };
	}
}
