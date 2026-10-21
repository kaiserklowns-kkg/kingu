// Languages and grammars snaps contribute (snaps/contrib.svelte.ts sets them; VS Code: the
// `languages` and `grammars` contribution points). Monaco loads lazily, so they wait here until
// the TextMate setup binds Monaco (textmate/index.ts); later changes apply right away. No Monaco
// import, so the snaps store can set them without loading the editor.

import type * as Monaco from 'monaco-editor';
import type { MonacoLanguageConfiguration } from '#lib/snaps/contributions.ts';

export type ContributedLanguageSource = {
	id: string;
	aliases: string[];
	extensions: string[];
	filenames: string[];
	/** Reads and converts the snap's language-configuration.json; null when it has none. */
	configuration: (() => Promise<MonacoLanguageConfiguration>) | null;
};

export type ContributedGrammarSource = {
	scopeName: string;
	path: string;
	language: string | null;
	embeddedLanguages: Record<string, string>;
	tokenTypes: Record<string, number>;
	injectTo: string[];
	unbalancedBracketSelectors: string[];
	load: () => Promise<string>;
};

let languages: ContributedLanguageSource[] = [];
let grammars: ContributedGrammarSource[] = [];
let bound: { monaco: typeof Monaco; onGrammars: (g: ContributedGrammarSource[]) => void } | null = null;
const configurations = new Map<string, Monaco.IDisposable>();
const registered = new Set<string>();

function apply() {
	if (!bound) return;
	const { monaco } = bound;
	const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
	for (const l of languages) {
		// Monaco has no unregister: an id stays known until reload (harmless, nothing maps to it).
		if (!known.has(l.id) && !registered.has(l.id)) {
			monaco.languages.register({ id: l.id, aliases: l.aliases, extensions: l.extensions, filenames: l.filenames });
			registered.add(l.id);
		}
	}
	for (const [id, d] of [...configurations]) {
		d.dispose();
		configurations.delete(id);
	}
	for (const l of languages) {
		const load = l.configuration;
		if (!load) continue;
		void load()
			.then((conf) => {
				if (!languages.includes(l)) return;
				configurations.get(l.id)?.dispose();
				configurations.set(l.id, monaco.languages.setLanguageConfiguration(l.id, conf as Monaco.languages.LanguageConfiguration));
			})
			.catch((e) => console.warn(`snap language ${l.id}: ${e}`));
	}
	bound.onGrammars(grammars);
}

/** What snaps contribute now (replaces the previous set). */
export function setContributedLanguages(next: { languages: ContributedLanguageSource[]; grammars: ContributedGrammarSource[] }) {
	languages = next.languages;
	grammars = next.grammars;
	apply();
}

/** Called once by the TextMate setup with Monaco and how to (re)register snap grammars. */
export function bindContributedLanguages(monaco: typeof Monaco, onGrammars: (g: ContributedGrammarSource[]) => void) {
	bound = { monaco, onGrammars };
	apply();
}
