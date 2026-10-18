import { describe, expect, test } from 'bun:test';
import { isNotebookPath, parseNotebook } from './notebook';

const nb = {
	metadata: { language_info: { name: 'python' } },
	nbformat: 4,
	cells: [
		{ cell_type: 'markdown', source: ['# Title\n', 'text'] },
		{
			cell_type: 'code',
			execution_count: 3,
			source: 'print(1)',
			outputs: [
				{ output_type: 'stream', name: 'stdout', text: ['1\n'] },
				{ output_type: 'display_data', data: { 'image/png': 'iVBO\nRw==', 'text/plain': '<Figure>' } },
				{ output_type: 'execute_result', data: { 'text/plain': ['42'] } },
				{ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mValueError\u001b[0m: bad'] }
			]
		}
	]
};

describe('parseNotebook', () => {
	test('cells, sources and outputs', () => {
		const p = parseNotebook(JSON.stringify(nb));
		expect(p.language).toBe('python');
		expect(p.cells[0]).toEqual({ kind: 'markdown', source: '# Title\ntext', count: null, outputs: [] });
		expect(p.cells[1].count).toBe(3);
		expect(p.cells[1].outputs).toEqual([
			{ kind: 'text', text: '1\n' },
			{ kind: 'image', src: 'data:image/png;base64,iVBORw==' },
			{ kind: 'text', text: '42' },
			{ kind: 'error', text: 'ValueError: bad' }
		]);
	});
	test('rejects JSON that is not a notebook', () => {
		expect(() => parseNotebook('{"a":1}')).toThrow();
		expect(isNotebookPath('a/b.IPYNB')).toBe(true);
		expect(isNotebookPath('preview:a.ipynb')).toBe(false);
	});
});
