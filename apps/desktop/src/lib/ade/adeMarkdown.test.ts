import { describe, expect, test } from 'bun:test';
import { forgetUntitledMarkdown, isMarkdownEditor, markUntitledMarkdown } from './adeMarkdown';

describe('Markdown tabs of the Agents layout', () => {
	test('a .md file and a New Markdown buffer are Markdown editors', () => {
		expect(isMarkdownEditor('notes.md')).toBe(true);
		expect(isMarkdownEditor('docs/a.markdown')).toBe(true);
		expect(isMarkdownEditor('a.ts')).toBe(false);
		expect(isMarkdownEditor('untitled:Untitled-1')).toBe(false);
		markUntitledMarkdown('untitled:Untitled-1');
		expect(isMarkdownEditor('untitled:Untitled-1')).toBe(true);
		forgetUntitledMarkdown('untitled:Untitled-1');
		expect(isMarkdownEditor('untitled:Untitled-1')).toBe(false);
	});
});
