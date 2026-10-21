/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { resolveSettings, SETTINGS } from '#lib/settings/registry.ts';
import { chatNotifies, confirmsRewind, defaultModePick, notifySettingFor, pastedContext, savedBeforeSend, thinkingStyle, thinkingView } from './chatSettings';
import { mayHaveMath, splitMarkdown } from './chatMarkdown';
import { referenceLabel, resultPaths, turnReferences } from './chatReferences';
import type { Part, ToolPart } from './chatParts';

const getter = (user: Record<string, unknown>) => {
	const m = resolveSettings(user, {});
	return (id: string) => m.get(id)?.value;
};

describe('chat.notifyWindowOn*', () => {
	test('a confirmation and a response each have their setting; other events none', () => {
		expect(notifySettingFor({ kind: 'permission_request' })).toBe('chat.notifyWindowOnConfirmation');
		expect(notifySettingFor({ kind: 'result' })).toBe('chat.notifyWindowOnResponseReceived');
		expect(notifySettingFor({ kind: 'message' })).toBeNull();
	});
	test('windowNotFocused (the default) only while unfocused; always; off', () => {
		const ev = { kind: 'result' };
		expect(chatNotifies(ev, getter({}), false)).toBe(true);
		expect(chatNotifies(ev, getter({}), true)).toBe(false);
		expect(chatNotifies(ev, getter({ 'chat.notifyWindowOnResponseReceived': 'always' }), true)).toBe(true);
		expect(chatNotifies(ev, getter({ 'chat.notifyWindowOnResponseReceived': 'off' }), false)).toBe(false);
		// The confirmation setting does not change responses.
		expect(chatNotifies(ev, getter({ 'chat.notifyWindowOnConfirmation': 'off' }), false)).toBe(true);
		expect(chatNotifies({ kind: 'permission_request' }, getter({ 'chat.notifyWindowOnConfirmation': 'off' }), false)).toBe(false);
		expect(chatNotifies({ kind: 'message' }, getter({ 'chat.notifyWindowOnResponseReceived': 'always' }), false)).toBe(false);
	});
});

describe('chat.editing.confirmEditRequest*', () => {
	const user = (values: Record<string, unknown>) => (id: string) => values[id];
	test('removal and retry each read their own setting', () => {
		const v = { 'chat.editing.confirmEditRequestRetry': false };
		expect(confirmsRewind('retry', getter(v), user(v))).toBe(false);
		expect(confirmsRewind('removal', getter(v), user(v))).toBe(true);
		expect(confirmsRewind('removal', getter({}), user({}))).toBe(true);
	});
	test('an old kingu.chat.confirmRewind: false still turns them off until the new key is set', () => {
		const old = { 'kingu.chat.confirmRewind': false };
		expect(confirmsRewind('removal', getter(old), user(old))).toBe(false);
		expect(confirmsRewind('retry', getter(old), user(old))).toBe(false);
		const both = { ...old, 'chat.editing.confirmEditRequestRemoval': true };
		expect(confirmsRewind('removal', getter(both), user(both))).toBe(true);
	});
	test('kingu.chat.confirmRewind is no longer registered', () => {
		expect(SETTINGS.some((s) => s.id === 'kingu.chat.confirmRewind')).toBe(false);
	});
});

describe('chat.agent.thinkingStyle', () => {
	test('unknown values read as the default, fixedScrolling', () => {
		expect(thinkingStyle(undefined)).toBe('fixedScrolling');
		expect(thinkingStyle('collapsed')).toBe('collapsed');
		expect(thinkingStyle('x')).toBe('fixedScrolling');
	});
	test('each style while the agent thinks and after; a click wins', () => {
		expect(thinkingView('collapsed', true, undefined)).toBe('closed');
		expect(thinkingView('collapsedPreview', true, undefined)).toBe('open');
		expect(thinkingView('collapsedPreview', false, undefined)).toBe('closed');
		expect(thinkingView('fixedScrolling', true, undefined)).toBe('scroll');
		expect(thinkingView('fixedScrolling', false, undefined)).toBe('closed');
		expect(thinkingView('fixedScrolling', true, true)).toBe('open');
		expect(thinkingView('collapsedPreview', true, false)).toBe('closed');
	});
});

describe('chat.newSession.defaultMode', () => {
	const agents = [{ name: 'Reviewer' }];
	test('built-in modes, custom agents by name, nothing for the rest', () => {
		expect(defaultModePick('', agents)).toBeNull();
		expect(defaultModePick(undefined, agents)).toBeNull();
		expect(defaultModePick('Agent', agents)).toBe('agent');
		expect(defaultModePick('edit', agents)).toBe('agent');
		expect(defaultModePick('ask', agents)).toBe('ask');
		expect(defaultModePick('plan', agents)).toBe('plan');
		expect(defaultModePick('reviewer', agents)).toBe('custom:Reviewer');
		expect(defaultModePick('missing', agents)).toBeNull();
	});
});

describe('chat.pasteAsAttachmentThreshold', () => {
	test('only a paste longer than the threshold is attached', () => {
		expect(pastedContext('x'.repeat(10000), 10000)).toBeNull();
		expect(pastedContext('a\nb\nc', 2)).toMatchObject({ kind: 'paste', text: 'a\nb\nc' });
		expect(pastedContext('a\nb\nc', 2)?.label).toContain('3');
		// A bad value falls back to VS Code's 10000.
		expect(pastedContext('x'.repeat(500), -1)).toBeNull();
	});
});

describe('chat.saveBeforeSend', () => {
	test('saves files, not untitled editors, diffs or other resources', () => {
		expect(savedBeforeSend(['src/a.ts', 'untitled:Untitled-1', 'diff:src/a.ts', 'kingu-settings:user', '/abs/b.ts'])).toEqual(['src/a.ts', '/abs/b.ts']);
	});
});

describe('chat.math.enabled in chat markdown', () => {
	test('off: dollars stay text and mermaid stays a code block', () => {
		const segs = splitMarkdown('Cost $x$ here\n\n```mermaid\ngraph TD; A-->B\n```\n');
		expect(segs.map((s) => s.kind)).toEqual(['markdown', 'code']);
		expect(segs[0].kind === 'markdown' && segs[0].html).toContain('$x$');
	});
	test('on: math renders with the renderer (as code until it loads) and mermaid is a diagram', () => {
		const before = splitMarkdown('Area $\\pi r^2$', { math: true });
		expect(before[0].kind === 'markdown' && before[0].html).toContain('<code class="md-math">\\pi r^2</code>');
		const after = splitMarkdown('Area $\\pi r^2$\n\n$$\nx\n$$\n', { math: true, renderMath: (tex, display) => `<span data-math="${display}">${tex}</span>` });
		const html = after[0].kind === 'markdown' ? after[0].html : '';
		expect(html).toContain('<span data-math="false">\\pi r^2</span>');
		expect(html).toContain('<span data-math="true">x</span>');
		expect(splitMarkdown('```Mermaid\ngraph TD; A-->B\n```', { math: true })).toEqual([{ kind: 'mermaid', code: 'graph TD; A-->B' }]);
	});
	test('money is not math, and raw HTML stays text', () => {
		const html = splitMarkdown('It costs $5 and $6 <img src=x onerror=alert(1)>', { math: true, renderMath: () => 'MATH' })[0];
		expect(html.kind === 'markdown' && html.html).not.toContain('MATH');
		expect(html.kind === 'markdown' && html.html).not.toContain('<img');
		expect(mayHaveMath('no math here')).toBe(false);
		expect(mayHaveMath('$a+b$')).toBe(true);
	});
});

describe('Used N references', () => {
	const tool = (name: string, input: unknown, content?: string, children?: Part[]): ToolPart => ({ kind: 'tool', id: name + JSON.stringify(input), name, input, ...(content !== undefined ? { result: { content, isError: false } } : {}), ...(children ? { children } : {}) });
	test('Grep and Glob results: file lines, content-mode matches, no summaries', () => {
		expect(resultPaths('Found 2 files\nsrc/a.ts\n/abs/my dir/b.ts\n')).toEqual([{ path: 'src/a.ts' }, { path: '/abs/my dir/b.ts' }]);
		expect(resultPaths('src/a.ts:12:  const x = 1\nNo matches found')).toEqual([{ path: 'src/a.ts', line: 12 }]);
		expect(resultPaths('No files found')).toEqual([]);
		expect(resultPaths('this is a sentence.\n42')).toEqual([]);
	});
	test('Read, Grep and Glob of the turn and its subagents, once each, edits left out', () => {
		const parts: Part[] = [
			{ kind: 'markdown', text: 'hi' },
			tool('Read', { file_path: '/w/src/a.ts' }, 'file'),
			tool('Read', { file_path: '/w/src/a.ts', offset: 40 }, 'file'),
			tool('Edit', { file_path: '/w/src/c.ts', old_string: 'a', new_string: 'b' }, 'ok'),
			tool('Grep', { pattern: 'x' }, 'src/b.ts:3:x'),
			tool('Task', { description: 'look' }, 'done', [tool('Glob', { pattern: '*.md' }, 'README.md')]),
			{ kind: 'tool', id: 'r2', name: 'Read', input: { file_path: '/w/missing.ts' }, result: { content: 'no such file', isError: true } }
		];
		expect(turnReferences(parts)).toEqual([{ path: '/w/src/a.ts' }, { path: 'src/b.ts', line: 3 }, { path: 'README.md' }]);
		expect(turnReferences(parts, 1)).toHaveLength(1);
	});
	test('a pill shows the file name and its folder', () => {
		expect(referenceLabel('src/lib/a.ts')).toEqual({ name: 'a.ts', dir: 'src/lib' });
		expect(referenceLabel('README.md')).toEqual({ name: 'README.md', dir: '' });
	});
});
