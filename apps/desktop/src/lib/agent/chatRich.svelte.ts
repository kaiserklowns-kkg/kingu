// The chat's math and diagrams (chat.math.enabled), loaded on first use so KaTeX and mermaid stay
// out of the first paint:
//   chatMath.renderer / load()      KaTeX (lib/markdown/katex.ts: no \href, no HTML, trust off)
//   renderMermaid(code, dark)       a ```mermaid block as an SVG image (`data:` URL)
// A diagram is drawn by mermaid in its strict mode (labels sanitized, no click handlers, plain SVG
// text labels) and then shown as an <img>, so nothing in it can run script, take events or load
// anything: the webview treats it as a picture.

import type { MathRenderer } from '#lib/markdown/previewRender.ts';

class ChatMath {
	renderer = $state.raw<MathRenderer | null>(null);
	#loading = false;

	load() {
		if (this.renderer || this.#loading) return;
		this.#loading = true;
		void import('#lib/markdown/katex.ts')
			.then((m) => (this.renderer = m.renderMath))
			.catch(() => (this.#loading = false));
	}
}

export const chatMath = new ChatMath();

type Mermaid = (typeof import('mermaid'))['default'];
let mermaid: Promise<Mermaid> | null = null;
let theme: 'dark' | 'default' | null = null;
let seq = 0;
/** Drawn diagrams by theme and source, the newest kept. */
const drawn = new Map<string, Promise<string>>();
const MAX_DRAWN = 40;

async function draw(code: string, dark: boolean): Promise<string> {
	const m = await (mermaid ??= import('mermaid').then((x) => x.default));
	const want = dark ? 'dark' : 'default';
	if (theme !== want) {
		m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: want, htmlLabels: false, flowchart: { htmlLabels: false }, suppressErrorRendering: true });
		theme = want;
	}
	const { svg } = await m.render(`kg-chat-mermaid-${++seq}`, code);
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The diagram of `code` as an image URL; rejects with mermaid's parse error. */
export function renderMermaid(code: string, dark: boolean): Promise<string> {
	const key = `${dark ? 'd' : 'l'}\u0000${code}`;
	let p = drawn.get(key);
	if (!p) {
		p = draw(code, dark);
		// A failed one is drawn again next time (it may have been cut off).
		p.catch(() => drawn.delete(key));
		drawn.set(key, p);
		if (drawn.size > MAX_DRAWN) drawn.delete(drawn.keys().next().value!);
	}
	return p;
}
