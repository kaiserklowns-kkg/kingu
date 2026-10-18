// A response's code block: syntax colouring with Monaco's colorizer (the editor's TextMate
// grammars and theme, like VS Code's read-only code block editors), and the Insert into New File
// and Insert into Terminal actions (chatCodeblockActions). Monaco loads on the first block shown.

import { t } from '#lib/i18n/index.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { newUntitled } from '#lib/workbench/editorCommands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { focusTerminal, terminalHandle } from '#lib/terminal/registry.ts';
import { fenceLanguage, terminalInput } from './chatCode';

type MonacoModule = typeof import('#lib/editor/monaco.ts');

let loading: Promise<MonacoModule> | undefined;
/** Monaco with the TextMate tokenizers and the workbench theme in place. */
function monaco(): Promise<MonacoModule> {
	return (loading ??= import('#lib/editor/monaco.ts').then(async (m) => {
		await m.setupTextMate();
		return m;
	}));
}

/** Coloured blocks by language and text: a re-render (or a scroll back) does not tokenize again. */
const cache = new Map<string, string>();
const CACHE_MAX = 200;

/**
 * The block as Monaco's colorizer HTML (token spans of escaped text, safe for `{@html}`), or null
 * when its language is unknown or the colorizer fails (the block stays plain text).
 */
export async function colorize(code: string, fence: string): Promise<string | null> {
	const key = `${fence}\u0000${code}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	try {
		const m = await monaco();
		const lang = fenceLanguage(fence, m.monaco.languages.getLanguages());
		if (!lang || lang === 'plaintext') return null;
		const html = await m.monaco.editor.colorize(code.replace(/\n$/, ''), lang, { tabSize: 4 });
		if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
		cache.set(key, html);
		return html;
	} catch {
		return null;
	}
}

/** Insert into New File: a new untitled editor with the code, in the fence's language. */
export async function insertIntoNewFile(code: string, fence: string) {
	newUntitled();
	const key = editors.active;
	try {
		const m = await monaco();
		// The editor makes the untitled model as it mounts.
		for (let i = 0; i < 50; i++) {
			const model = key ? editors.textModel(key) : null;
			if (model) {
				model.setValue(code);
				const lang = fenceLanguage(fence, m.monaco.languages.getLanguages());
				if (lang) m.monaco.editor.setModelLanguage(model, lang);
				return;
			}
			await new Promise((r) => setTimeout(r, 40));
		}
	} catch {
		// Shown below.
	}
	status.flash(t('chatParts.code.newFileFailed'), 5000);
}

/** Insert into Terminal: the panel's active terminal (a new one when there is none), without running it. */
export function insertIntoTerminal(code: string) {
	if (terminals.tag === null) {
		status.flash(t('chatParts.code.noTerminal'), 5000);
		return;
	}
	layout.showPanel('terminal');
	const id = terminals.get(terminals.active) ? terminals.active : terminals.open();
	const key = terminals.key(id);
	const text = terminalInput(code);
	// A terminal just opened or shown mounts on a later tick.
	const send = (tries: number) => {
		const h = terminalHandle(key);
		if (h) {
			h.write(text);
			focusTerminal(key);
		} else if (tries > 0) setTimeout(() => send(tries - 1), 50);
	};
	send(40);
}
