// Editor tab labels (VS Code: the editor label's name and description). Pure, so `bun test`
// checks them: `workbench.editor.labelFormat` (the description after the name),
// `workbench.editor.customLabels.patterns` (customEditorLabelService.ts) and
// `workbench.editor.untitled.labelFormat` (an untitled editor named after its first line).

import { globToRegExp } from '#lib/settings/mappings.ts';

export type LabelFormat = 'default' | 'short' | 'medium' | 'long';

const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

/**
 * The description shown after a tab's name. `default`: only for tabs whose name another tab of the
 * group shares, the shortest folder suffix that tells them apart; `short`: the parent folder;
 * `medium`: the folder relative to the workspace; `long`: the absolute folder.
 */
export function tabDescription(rel: string, others: readonly string[], format: LabelFormat, root: string): string {
	const dir = dirOf(rel);
	switch (format) {
		case 'short':
			return dir ? baseOf(dir) : '';
		case 'medium':
			return dir;
		case 'long':
			return dir ? `${root}/${dir}` : root;
	}
	const name = baseOf(rel);
	const twins = [...new Set(others)].filter((o) => o !== rel && baseOf(o) === name);
	if (!twins.length) return '';
	const parts = dir ? dir.split('/') : [];
	const tail = (d: string, n: number) => (d ? d.split('/') : []).slice(-n).join('/');
	for (let n = 1; n <= parts.length; n++) {
		const suffix = tail(dir, n);
		if (twins.every((t) => tail(dirOf(t), n) !== suffix)) return n < parts.length ? `…/${suffix}` : suffix;
	}
	return dir;
}

type Pattern = { pattern: string; template: string; re: RegExp; absolute: boolean };

/** VS Code's weight: more specific patterns first. */
function weight(pattern: string): number {
	let w = 0;
	for (const f of pattern.split('/')) {
		if (f === '**') w += 1;
		else if (f === '*') w += 10;
		else if (f.includes('*') || f.includes('?')) w += 50;
		else if (f !== '') w += 100;
	}
	return w;
}

/** The usable `workbench.editor.customLabels.patterns`, most specific first. */
export function customLabelPatterns(patterns: Readonly<Record<string, string>>): Pattern[] {
	return Object.entries(patterns)
		.filter(([, template]) => typeof template === 'string' && /[a-zA-Z0-9]/.test(template))
		.map(([pattern, template]) => ({ pattern, template, re: new RegExp(globToRegExp(pattern).source, 'i'), absolute: pattern.startsWith('/') }))
		.sort((a, b) => weight(b.pattern) - weight(a.pattern));
}

function nth(fragments: string[], n: number): string | undefined {
	const i = n < 0 ? Math.abs(n) - 1 : fragments.length - n - 1;
	return fragments[i] || undefined;
}

const TEMPLATE = /\$\{(dirname|filename|extname|extname\(([-+]?\d+)\)|dirname\(([-+]?\d+)\))\}/g;

/**
 * The custom tab name of a workspace file, or undefined. Like VS Code, a relative pattern matches
 * the path below the workspace's parent (`myFolder/src/index.ts`), an absolute one the full path.
 * Templates use `${filename}`, `${extname}`, `${extname(N)}`, `${dirname}` and `${dirname(N)}`.
 */
export function customLabel(rel: string, root: string, patterns: readonly Pattern[]): string | undefined {
	const abs = `${root}/${rel}`;
	const rootName = baseOf(root);
	for (const p of patterns) {
		const relevant = p.absolute ? abs : `${rootName}/${rel}`;
		if (!p.re.test(relevant)) continue;
		const base = baseOf(abs);
		const noDot = base.replace(/^\.+/, '');
		return p.template.replace(TEMPLATE, (match, variable: string, extN?: string, dirN?: string) => {
			let out: string | undefined;
			if (variable === 'filename') out = /^\.*[^.]*/.exec(base)?.[0];
			else if (variable === 'extname') out = noDot.split('.').slice(1).join('.');
			else if (variable.startsWith('extname')) out = nth(noDot.split('.').slice(1), parseInt(extN ?? '0'));
			else out = nth(dirOf(relevant).replace(/^\//, '').split('/'), parseInt(dirN ?? '0'));
			return out || match;
		});
	}
	return undefined;
}

/** `workbench.editor.untitled.labelFormat: content`: an untitled editor is named after its first line (VS Code caps it at 40). */
export function untitledLabel(name: string, firstLine: string, format: 'content' | 'name'): string {
	if (format === 'name') return name;
	const text = firstLine.trim().slice(0, 40).trim();
	return text || name;
}
