import { describe, expect, test } from 'bun:test';
import { parseNotebookDocument, type NbDocument } from './notebook';
import { appendOutput, NotebookExecution, type KernelEvent, type KernelRequest, type KernelTransport } from './notebookKernel';

/** A fake kernel: records requests; the test plays the kernel's events. */
class FakeKernel implements KernelTransport {
	sent: KernelRequest[] = [];
	emit: (e: KernelEvent) => void = () => {};
	stopped = false;
	failStart = false;
	async start(onEvent: (e: KernelEvent) => void) {
		if (this.failStart) throw new Error('no jupyter');
		this.emit = onEvent;
	}
	async send(req: KernelRequest) {
		this.sent.push(req);
	}
	async stop() {
		this.stopped = true;
	}
}

const nb = () =>
	parseNotebookDocument(
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			metadata: {},
			cells: [
				{ cell_type: 'code', id: 'a', source: 'print(1)', outputs: [{ output_type: 'stream', name: 'stdout', text: 'old' }], execution_count: 9, metadata: {} },
				{ cell_type: 'code', id: 'b', source: 'x', outputs: [], execution_count: null, metadata: {} },
				{ cell_type: 'markdown', id: 'm', source: '# h', metadata: {} },
				{ cell_type: 'code', id: 'e', source: '  ', outputs: [], execution_count: null, metadata: {} }
			]
		})
	);

function setup() {
	const doc: NbDocument = nb();
	const kernel = new FakeKernel();
	let docChanges = 0;
	const ex = new NotebookExecution(
		() => doc,
		(d) => void (d && docChanges++),
		() => kernel
	);
	return { doc, kernel, ex, changes: () => docChanges };
}

describe('NotebookExecution', () => {
	test('runs code cells in order with counts and outputs', async () => {
		const { doc, kernel, ex } = setup();
		await ex.execute(['a', 'b', 'm', 'e']);
		// Markdown and empty cells are skipped; outputs clear at once.
		expect(kernel.sent).toEqual([
			{ op: 'execute', run: 'r1', code: 'print(1)' },
			{ op: 'execute', run: 'r2', code: 'x' }
		]);
		expect(doc.cells[0]).toMatchObject({ outputs: [], count: null });
		expect(ex.stateOf('a')).toBe('queued');
		expect(ex.status).toBe('starting');

		kernel.emit({ ev: 'ready', info: { language_info: { name: 'python', version: '3.12' } } });
		expect(ex.status).toBe('idle');
		kernel.emit({ ev: 'status', state: 'busy' });
		kernel.emit({ ev: 'input', run: 'r1', count: 1 });
		expect(ex.stateOf('a')).toBe('running');
		expect(doc.cells[0].count).toBe(1);
		expect(doc.metadata.language_info).toEqual({ name: 'python', version: '3.12' });
		kernel.emit({ ev: 'output', run: 'r1', output: { output_type: 'stream', name: 'stdout', text: '1\n' } });
		kernel.emit({ ev: 'output', run: 'r1', output: { output_type: 'stream', name: 'stdout', text: '2\n' } });
		kernel.emit({ ev: 'output', run: 'r1', output: { output_type: 'stream', name: 'stderr', text: 'w' } });
		kernel.emit({ ev: 'done', run: 'r1', count: 1, status: 'ok' });
		expect(doc.cells[0].outputs).toEqual([
			{ output_type: 'stream', name: 'stdout', text: '1\n2\n' },
			{ output_type: 'stream', name: 'stderr', text: 'w' }
		]);
		expect(ex.stateOf('a')).toBeUndefined();
		expect(ex.pending).toBe(1);
		kernel.emit({ ev: 'input', run: 'r2', count: 2 });
		kernel.emit({ ev: 'output', run: 'r2', output: { output_type: 'error', ename: 'NameError', evalue: 'x', traceback: [] } });
		kernel.emit({ ev: 'done', run: 'r2', count: 2, status: 'error' });
		expect(doc.cells[1]).toMatchObject({ count: 2, outputs: [{ output_type: 'error' }] });
		expect(ex.pending).toBe(0);
	});

	test('a cell already queued is not queued twice', async () => {
		const { kernel, ex } = setup();
		await ex.execute(['a']);
		await ex.execute(['a']);
		expect(kernel.sent).toHaveLength(1);
	});

	test('clear_output, with and without wait', async () => {
		const { doc, kernel, ex } = setup();
		await ex.execute(['a']);
		const out = (text: string) => kernel.emit({ ev: 'output', run: 'r1', output: { output_type: 'stream', name: 'stdout', text } });
		out('10%');
		kernel.emit({ ev: 'clear', run: 'r1', wait: true });
		expect(doc.cells[0].outputs).toHaveLength(1);
		out('20%');
		expect(doc.cells[0].outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: '20%' }]);
		kernel.emit({ ev: 'clear', run: 'r1', wait: false });
		expect(doc.cells[0].outputs).toEqual([]);
	});

	test('interrupt, aborted runs, restart', async () => {
		const { doc, kernel, ex } = setup();
		await ex.execute(['a', 'b']);
		await ex.interrupt();
		expect(kernel.sent.at(-1)).toEqual({ op: 'interrupt' });
		kernel.emit({ ev: 'done', run: 'r2', count: null, status: 'aborted' });
		expect(doc.cells[1].count).toBeNull();
		await ex.restart();
		expect(kernel.sent.at(-1)).toEqual({ op: 'restart' });
		expect(ex.status).toBe('restarting');
		expect(ex.pending).toBe(0);
		// Late events of the old runs are ignored.
		kernel.emit({ ev: 'output', run: 'r1', output: { output_type: 'stream', name: 'stdout', text: 'late' } });
		expect(doc.cells[0].outputs).toEqual([]);
		kernel.emit({ ev: 'ready' });
		expect(ex.status).toBe('idle');
	});

	test('a dead kernel, a failed start and shutdown', async () => {
		const { kernel, ex } = setup();
		await ex.execute(['a']);
		kernel.emit({ ev: 'fatal', message: 'The kernel died.' });
		expect(ex.status).toBe('dead');
		expect(ex.error).toBe('The kernel died.');
		expect(ex.pending).toBe(0);
		kernel.failStart = true;
		await expect(ex.execute(['a'])).rejects.toThrow('no jupyter');
		expect(ex.status).toBe('dead');
		expect(ex.pending).toBe(0);
		kernel.failStart = false;
		await ex.execute(['b']);
		await ex.shutdown();
		expect(kernel.stopped).toBe(true);
		expect(ex.status).toBe('off');
		kernel.emit({ ev: 'exit', code: 0 });
		expect(ex.status).toBe('off');
	});

	test('appendOutput joins stream text of one stream only', () => {
		const cell = { outputs: [{ output_type: 'stream', name: 'stdout', text: ['a\n'] }] as Record<string, unknown>[] };
		appendOutput(cell, { output_type: 'stream', name: 'stdout', text: 'b' });
		appendOutput(cell, { output_type: 'display_data', data: {} });
		appendOutput(cell, { output_type: 'stream', name: 'stdout', text: 'c' });
		expect(cell.outputs.map((o) => o.text ?? o.output_type)).toEqual(['a\nb', 'display_data', 'c']);
	});
});
