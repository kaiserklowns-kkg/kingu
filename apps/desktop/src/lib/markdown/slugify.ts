// Header ids for `#fragment` links (VS Code's github slugifier): the header's text without its
// inline Markdown, lowercased, whitespace to `-`, punctuation dropped. Letters, marks (Thai
// vowels and tone marks), digits, `_` and `-` stay. Shared by the language features and the preview
// so a link that resolves in the editor also scrolls in the preview.

/** The visible text of a header's inline Markdown: link and image text, no emphasis or code ticks. */
export function headerText(raw: string): string {
	return raw
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/(\*\*|__|\*|_|~~|`+)(?=\S)([\s\S]*?\S)\1/g, '$2')
		.trim();
}

export function slugify(text: string): string {
	return headerText(text)
		.toLowerCase()
		.replace(/\s/g, '-')
		.replace(/[^\p{L}\p{M}\p{N}_-]/gu, '')
		.replace(/^-+|-+$/g, '');
}

/** Slugs for headers in document order; a repeated slug gets `-1`, `-2`… like GitHub. */
export class Slugs {
	#seen = new Map<string, number>();

	next(text: string): string {
		const base = slugify(text);
		const n = this.#seen.get(base);
		if (n === undefined) {
			this.#seen.set(base, 0);
			return base;
		}
		let i = n + 1;
		while (this.#seen.has(`${base}-${i}`)) i++;
		this.#seen.set(base, i);
		this.#seen.set(`${base}-${i}`, 0);
		return `${base}-${i}`;
	}
}
