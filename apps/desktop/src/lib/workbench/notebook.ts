// Jupyter notebooks (.ipynb, nbformat 4) for the notebook viewer (Orca's IpynbViewer): cells and
// their saved outputs, normalized for display. Read-only: nothing is executed.

export type NotebookOutput = { kind: 'text'; text: string } | { kind: 'image'; src: string } | { kind: 'error'; text: string };
export type NotebookCell = { kind: 'markdown' | 'code' | 'raw'; source: string; count: number | null; outputs: NotebookOutput[] };
export type Notebook = { language: string; cells: NotebookCell[] };

type Json = Record<string, unknown>;

const text = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');
/** Terminal colors in tracebacks are escape codes, not text. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

const IMAGES = ['image/png', 'image/jpeg', 'image/gif'] as const;

function outputsOf(cell: Json): NotebookOutput[] {
	const out: NotebookOutput[] = [];
	for (const o of (Array.isArray(cell.outputs) ? cell.outputs : []) as Json[]) {
		if (o.output_type === 'stream') out.push({ kind: 'text', text: text(o.text) });
		else if (o.output_type === 'error') out.push({ kind: 'error', text: stripAnsi(text(o.traceback) || `${o.ename}: ${o.evalue}`) });
		else if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
			const data = (o.data ?? {}) as Json;
			const image = IMAGES.find((m) => typeof data[m] === 'string' || Array.isArray(data[m]));
			// Base64 payloads may be split into lines.
			if (image) out.push({ kind: 'image', src: `data:${image};base64,${text(data[image]).replace(/\s/g, '')}` });
			else if (data['text/plain'] !== undefined) out.push({ kind: 'text', text: text(data['text/plain']) });
		}
	}
	return out;
}

export function parseNotebook(json: string): Notebook {
	const nb = JSON.parse(json) as Json;
	if (!Array.isArray(nb.cells)) throw new Error('ไม่ใช่ notebook รุ่น 4 (ไม่มี cells)');
	const meta = (nb.metadata ?? {}) as Json;
	const language = String(((meta.language_info ?? {}) as Json).name ?? ((meta.kernelspec ?? {}) as Json).language ?? 'python');
	const cells = (nb.cells as Json[]).map((c) => ({
		kind: c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : 'code',
		source: text(c.source),
		count: typeof c.execution_count === 'number' ? c.execution_count : null,
		outputs: c.cell_type === 'code' ? outputsOf(c) : []
	})) satisfies NotebookCell[];
	return { language, cells };
}

export const isNotebookPath = (key: string) => !key.includes(':') && /\.ipynb$/i.test(key);
