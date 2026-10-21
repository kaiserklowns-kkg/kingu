// Running notebook cells on a Jupyter kernel (VS Code's notebook execution service + the Jupyter
// extension's kernel). The kernel runs behind the Rust side's Python bridge (notebook/kernel.rs);
// this keeps the bookkeeping: which cell each run belongs to, queued / running cells, execution
// counts, outputs as they stream in (stream text joined, clear_output honoured), interrupt and
// restart. The transport is injected, so tests drive it with a fake kernel.

import type { Json, NbCell, NbDocument } from './notebook';
import { joinSource } from './notebook';

export type KernelSpec = { name: string; displayName: string; language: string };
export type KernelDiscovery = { python: string; specs: KernelSpec[] };

/** Events of the bridge (see kernel_bridge.py), plus `stderr` / `exit` from the Rust side. */
export type KernelEvent =
	| { ev: 'ready'; info?: { language_info?: Json; banner?: string } }
	| { ev: 'status'; state: 'busy' | 'idle' | 'restarting' }
	| { ev: 'input'; run: string; count: number | null }
	| { ev: 'output'; run: string; output: Json }
	| { ev: 'clear'; run: string; wait: boolean }
	| { ev: 'done'; run: string; count: number | null; status: 'ok' | 'error' | 'aborted' }
	| { ev: 'fatal'; message: string }
	| { ev: 'stderr'; line: string }
	| { ev: 'exit'; code: number | null };

export type KernelRequest = { op: 'execute'; run: string; code: string } | { op: 'interrupt' } | { op: 'restart' } | { op: 'shutdown' };

export interface KernelTransport {
	/** Starts the kernel; events arrive through `onEvent` until `exit`. */
	start(onEvent: (e: KernelEvent) => void): Promise<void>;
	send(req: KernelRequest): Promise<void>;
	stop(): Promise<void>;
}

export type KernelStatus = 'off' | 'starting' | 'idle' | 'busy' | 'restarting' | 'dead';
export type CellRunState = 'queued' | 'running';

type Run = { key: string; state: CellRunState; clearOnNext: boolean };

/** Appends `output` to `cell`; consecutive stream text of one stream becomes one output (Jupyter's). */
export function appendOutput(cell: Pick<NbCell, 'outputs'>, output: Json) {
	const last = cell.outputs[cell.outputs.length - 1];
	if (output.output_type === 'stream' && last?.output_type === 'stream' && last.name === output.name) {
		cell.outputs[cell.outputs.length - 1] = { ...last, text: joinSource(last.text) + joinSource(output.text) };
		return;
	}
	cell.outputs.push(output);
}

export class NotebookExecution {
	status: KernelStatus = 'off';
	/** Why the kernel is dead or failed to start. */
	error = '';
	languageInfo: Json | null = null;
	/** Kernel log lines (stderr), newest last, for the Output view. */
	log: string[] = [];
	#runs = new Map<string, Run>();
	#next = 1;
	#transport: KernelTransport | null = null;
	#starting: Promise<void> | null = null;

	constructor(
		private readonly doc: () => NbDocument,
		/** Called after every change to the document or the execution state. */
		private readonly changed: (docChanged: boolean) => void,
		private readonly connect: () => KernelTransport
	) {}

	/** The run state of a cell (for its indicator), if it is queued or running. */
	stateOf(key: string): CellRunState | undefined {
		for (const r of this.#runs.values()) if (r.key === key) return r.state;
		return undefined;
	}

	get pending(): number {
		return this.#runs.size;
	}

	#cell(run: string): NbCell | undefined {
		const r = this.#runs.get(run);
		return r && this.doc().cells.find((c) => c.key === r.key);
	}

	async #ensure(): Promise<void> {
		if (this.#transport && this.status !== 'dead') return this.#starting ?? undefined;
		this.#transport = this.connect();
		this.status = 'starting';
		this.error = '';
		this.changed(false);
		const t = this.#transport;
		this.#starting = t.start((e) => this.handle(e)).catch((e) => {
			this.#fail(String(e));
			throw e;
		});
		try {
			await this.#starting;
		} finally {
			this.#starting = null;
		}
	}

	#fail(message: string) {
		this.error = message;
		this.status = 'dead';
		this.#transport = null;
		this.#runs.clear();
		this.changed(false);
	}

	/**
	 * Queues the code cells `keys` (in notebook order of the call). Each cell's outputs are cleared
	 * and its count unset at once, as in VS Code. Empty cells and other kinds are skipped.
	 */
	async execute(keys: string[]): Promise<void> {
		const cells = keys.map((k) => this.doc().cells.find((c) => c.key === k)).filter((c): c is NbCell => !!c && c.kind === 'code' && c.source.trim() !== '' && !this.stateOf(c.key));
		if (!cells.length) return;
		const runs = cells.map((c) => {
			const run = `r${this.#next++}`;
			this.#runs.set(run, { key: c.key, state: 'queued', clearOnNext: false });
			c.outputs = [];
			c.count = null;
			return { run, code: c.source };
		});
		this.changed(true);
		try {
			await this.#ensure();
			for (const r of runs) await this.#transport?.send({ op: 'execute', run: r.run, code: r.code });
		} catch (e) {
			for (const r of runs) this.#runs.delete(r.run);
			if (this.status !== 'dead') this.#fail(String(e));
			throw e;
		}
	}

	async interrupt() {
		if (this.#transport && this.status !== 'dead') await this.#transport.send({ op: 'interrupt' });
	}

	async restart() {
		if (!this.#transport || this.status === 'dead') return this.#ensure();
		this.#runs.clear();
		this.status = 'restarting';
		this.changed(false);
		await this.#transport.send({ op: 'restart' });
	}

	/** Shuts the kernel down (the editor closed, or another kernel was picked). */
	async shutdown() {
		const t = this.#transport;
		this.#transport = null;
		this.#runs.clear();
		this.status = 'off';
		this.changed(false);
		if (t) await t.stop();
	}

	handle(e: KernelEvent) {
		switch (e.ev) {
			case 'ready':
				this.languageInfo = e.info?.language_info ?? null;
				this.status = 'idle';
				return this.changed(false);
			case 'status':
				if (e.state === 'restarting') this.#runs.clear();
				this.status = e.state;
				return this.changed(false);
			case 'input': {
				const r = this.#runs.get(e.run);
				const cell = this.#cell(e.run);
				if (!r || !cell) return;
				r.state = 'running';
				cell.count = e.count;
				// The kernel's language goes into the notebook with its first run (Jupyter saves it too).
				const meta = this.doc().metadata;
				if (this.languageInfo && JSON.stringify(meta.language_info) !== JSON.stringify(this.languageInfo)) meta.language_info = this.languageInfo;
				return this.changed(true);
			}
			case 'output': {
				const r = this.#runs.get(e.run);
				const cell = this.#cell(e.run);
				if (!r || !cell) return;
				if (r.clearOnNext) {
					cell.outputs = [];
					r.clearOnNext = false;
				}
				appendOutput(cell, e.output);
				return this.changed(true);
			}
			case 'clear': {
				const r = this.#runs.get(e.run);
				const cell = this.#cell(e.run);
				if (!r || !cell) return;
				// clear_output(wait=True) waits for the next output, so the cell does not flicker.
				if (e.wait) r.clearOnNext = true;
				else cell.outputs = [];
				return this.changed(!e.wait);
			}
			case 'done': {
				const cell = this.#cell(e.run);
				this.#runs.delete(e.run);
				if (cell && e.status !== 'aborted' && e.count !== null) cell.count = e.count;
				return this.changed(!!cell);
			}
			case 'fatal':
				this.log.push(e.message);
				return this.#fail(e.message);
			case 'stderr':
				this.log.push(e.line);
				if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
				return;
			case 'exit':
				if (this.status === 'off') return;
				return this.#fail(this.error || `exit ${e.code ?? ''}`.trim());
		}
	}
}
