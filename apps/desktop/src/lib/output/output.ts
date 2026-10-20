// Output channels, the pure part (VS Code: outputChannelModel.ts, outputView.ts's filter). The
// store is output.svelte.ts; this is what `bun test` checks.

/** Lines a channel keeps; older ones drop off (VS Code trims its output models too). */
export const CHANNEL_LIMIT = 5000;

/** Editor key of a channel opened in an editor (Output: Open Output in Editor): `output:<channel>`. */
export const OUTPUT_PREFIX = 'output:';
export const outputKey = (channel: string) => OUTPUT_PREFIX + channel;
export const isOutputKey = (key: string) => key.startsWith(OUTPUT_PREFIX);
export const outputChannelOf = (key: string) => key.slice(OUTPUT_PREFIX.length);

/** `lines` plus `text` split into lines (a trailing newline adds no empty line), at most `limit` kept. */
export function appendLines(lines: readonly string[], text: string | readonly string[], limit = CHANNEL_LIMIT): string[] {
	const added = typeof text === 'string' ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : text;
	const all = lines.concat(added);
	return all.length > limit ? all.slice(all.length - limit) : all;
}

/** Splits a whole text (a log file's tail) into lines. */
export const textLines = (text: string) => (text ? appendLines([], text) : []);

/**
 * The Output view's filter box: comma-separated terms, each a case-insensitive substring; `!term`
 * hides lines with it. A line shows when it has one of the plain terms (or there are none) and
 * none of the `!` ones.
 */
export type LineFilter = { include: string[]; exclude: string[] };

export function parseLineFilter(text: string): LineFilter {
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of text.split(',')) {
		const term = raw.trim();
		if (term.startsWith('!')) {
			const t = term.slice(1).trim().toLowerCase();
			if (t) exclude.push(t);
		} else if (term) include.push(term.toLowerCase());
	}
	return { include, exclude };
}

export function filterLines(lines: readonly string[], text: string): readonly string[] {
	const f = parseLineFilter(text);
	if (!f.include.length && !f.exclude.length) return lines;
	return lines.filter((line) => {
		const l = line.toLowerCase();
		return (!f.include.length || f.include.some((t) => l.includes(t))) && !f.exclude.some((t) => l.includes(t));
	});
}

/**
 * The lines of a log tail after a Clear: what came after the last line shown when it was cleared.
 * The tail is a moving window, so the line is looked up again; gone (rotated or scrolled off)
 * means everything is new.
 */
export function afterClear(lines: readonly string[], lastCleared: string | null): readonly string[] {
	if (lastCleared === null) return lines;
	const i = lines.lastIndexOf(lastCleared);
	return i < 0 ? lines : lines.slice(i + 1);
}

/** Channels in the picker: by label, like VS Code's Output dropdown. */
export const sortChannels = <T extends { label: string }>(channels: readonly T[]): T[] => [...channels].sort((a, b) => a.label.localeCompare(b.label));

/**
 * output.smartScroll.enabled: scrolling away from the end locks the view, scrolling back to the
 * end unlocks it. Returns the new lock (true = auto scrolling off), or the old one when smart
 * scrolling is off.
 */
export function smartScrollLock(locked: boolean, enabled: boolean, atEnd: boolean): boolean {
	return enabled ? !atEnd : locked;
}
