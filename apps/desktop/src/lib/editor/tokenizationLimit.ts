// `editor.maxTokenizationLineLength` for Kingu's TextMate tokenizer (Monaco's Monarch tokenizer
// reads the same setting from its configuration). Kept in a tiny module so the settings layer can
// set it without loading the grammars.

let limit = 20000;

export function setMaxTokenizationLineLength(value: number) {
	limit = value;
}

/** Lines this long or longer are not tokenized, like VS Code's TextMateTokenizationSupport. */
export const skipsTokenization = (lineLength: number) => lineLength >= limit;

/**
 * Monaco's `nullTokenizeEncoded`: the whole line as one token of the language with the default
 * colors (MetadataConsts: foreground 1, background 2).
 */
export function plainLineTokens(encodedLanguageId: number): Uint32Array {
	return new Uint32Array([0, ((encodedLanguageId << 0) | (1 << 15) | (2 << 24)) >>> 0]);
}
