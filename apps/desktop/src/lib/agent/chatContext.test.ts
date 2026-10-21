import { describe, expect, test } from 'bun:test';
import { folderContext, foldersOf, isInstructionsFile, lastCommandOutput, matchSources, mentionQuery, pastChatContext, problemsContext, removeMention } from './chatContext.ts';
import { assemblePrompt } from './chatPrompt.ts';

describe('mentions', () => {
	test('a # or @ word at the start or after a space, up to the caret', () => {
		expect(mentionQuery('#', 1)).toEqual({ start: 0, trigger: '#', query: '' });
		expect(mentionQuery('fix @src/a', 10)).toEqual({ start: 4, trigger: '@', query: 'src/a' });
		expect(mentionQuery('fix #pro more', 8)).toEqual({ start: 4, trigger: '#', query: 'pro' });
		expect(mentionQuery('mail me@x.com', 13)).toBeNull();
		expect(mentionQuery('#done ', 6)).toBeNull();
		expect(mentionQuery('issue#1', 7)).toBeNull();
	});

	test('picking takes the word out', () => {
		expect(removeMention('fix #pro more', 4, 8)).toEqual({ text: 'fix  more', caret: 4 });
	});

	test('sources match their label or id', () => {
		const label = (s: string) => ({ problems: 'Problems', scm: 'Source Control' })[s] ?? s;
		expect(matchSources('', label)).toHaveLength(9);
		expect(matchSources('sour', label)).toEqual(['scm', 'mcpResources']);
		expect(matchSources('PROB', label)).toEqual(['problems']);
	});
});

describe('context sources', () => {
	test('folders of a file list and a folder listing', () => {
		const files = ['a.ts', 'src/b.ts', 'src/lib/c.ts', 'srcx/d.ts'];
		expect(foldersOf(files)).toEqual(['src', 'src/lib', 'srcx']);
		expect(folderContext('src', files)).toEqual({ kind: 'folder', label: 'src', text: 'Folder src/ (2 files):\nsrc/b.ts\nsrc/lib/c.ts' });
		expect(folderContext('src', files, 1).text.endsWith('\n… 1 more')).toBe(true);
	});

	test('instructions files', () => {
		for (const p of ['CLAUDE.md', 'pkg/AGENTS.md', '.github/copilot-instructions.md', '.cursor/rules/style.mdc', '.claude/rules/x.md', '.github/instructions/ts.instructions.md']) expect(isInstructionsFile(p)).toBe(true);
		for (const p of ['README.md', 'docs/claude.md', '.cursor/x.md']) expect(isInstructionsFile(p)).toBe(false);
	});

	test('problems as rows, 1-based', () => {
		const at = (line: number, character: number) => ({ start: { line, character } });
		const p = problemsContext([
			{ label: 'src/a.ts', items: [{ range: at(0, 4), severity: 1, message: 'Cannot find\n  name x', source: 'ts', code: 2304 }] },
			{ label: 'b.py', items: [{ range: at(9, 0), severity: 2, message: 'unused' }] }
		]);
		expect(p).toEqual({ kind: 'problems', label: '2', text: 'src/a.ts:1:5 error: Cannot find name x (ts 2304)\nb.py:10:1 warning: unused' });
		expect(problemsContext([])).toBeNull();
		expect(problemsContext([{ label: 'a', items: [{ range: at(0, 0), message: 'x' }, { range: at(1, 0), message: 'y' }] }], 1)?.text).toBe('a:1:1 error: x\n… 1 more');
	});

	test("the terminal's last command, between two prompts", () => {
		const lines = ['me@mac app % ls', 'a  b', 'me@mac app % npm test', '', '3 passed', 'me@mac app %  ', ''];
		expect(lastCommandOutput(lines)).toEqual({ command: 'npm test', output: '\n3 passed' });
		expect(lastCommandOutput(['build ok', 'done'])).toEqual({ command: null, output: 'build ok\ndone' });
		expect(lastCommandOutput(['x', 'y', '$'], 1)).toEqual({ command: null, output: 'y' });
		expect(lastCommandOutput([])).toEqual({ command: null, output: '' });
	});

	test('a past chat: what was typed and answered, newest kept', () => {
		const sent = assemblePrompt('fix the build', [{ path: 'a.ts', content: 'x' }]);
		const events = [
			{ kind: 'message', role: 'user', text: sent },
			{ kind: 'message', role: 'assistant', text: 'sub', parent_tool_use_id: 't1' },
			{ kind: 'message', role: 'assistant', text: ' Done. ' }
		] as const;
		expect(pastChatContext('Build', [...events])).toEqual({ kind: 'chat', label: 'Build', text: 'Earlier chat "Build":\n\nUser: fix the build\n\nAssistant: Done.' });
		expect(pastChatContext('x', [])).toBeNull();
		expect(pastChatContext('x', [...events], 5)?.text).toContain('… (earlier messages cut)\n\nDone.');
	});
});
