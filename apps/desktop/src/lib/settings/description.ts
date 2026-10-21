// VS Code's setting descriptions are Markdown with setting links (`#editor.tabSize#`). The settings
// editor shows them as text with inline code, web links and setting links that jump to the
// setting, like VS Code's settings editor (settingsTreeModels).

export type DescriptionPart = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'setting'; id: string } | { kind: 'link'; text: string; href: string };

// `#id#` (optionally in backticks), `code`, or [text](url).
const TOKEN = /`?#([A-Za-z][\w.-]*\.[\w.-]+)#`?|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function describeParts(text: string): DescriptionPart[] {
	const out: DescriptionPart[] = [];
	let last = 0;
	for (const m of text.matchAll(TOKEN)) {
		if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
		if (m[1]) out.push({ kind: 'setting', id: m[1] });
		else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
		else out.push({ kind: 'link', text: m[3], href: m[4] });
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
	return out;
}

/** Only web links open (in the browser); `command:` and other schemes of VS Code's text stay text. */
export const isWebLink = (href: string) => /^https?:\/\//i.test(href);
