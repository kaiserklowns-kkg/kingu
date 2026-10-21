// The fake MCP server (fake-mcp.ts, with its resources, prompts, `elicit` and `sample` tools) as
// a stdio program, for runs that start their servers themselves. No network, no model.

import { FakeMcp } from './fake-mcp.ts';

const f = new FakeMcp();
f.extras = true;
f.paged = false;
let next = 1000;
const waiting = new Map<number, (v: any) => void>();
const send = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
const ask = (method: string, params?: unknown) =>
	new Promise<any>((resolve) => {
		const id = ++next;
		waiting.set(id, resolve);
		send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
	});

const decoder = new TextDecoder();
let buffered = '';
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let nl: number;
	while ((nl = buffered.indexOf('\n')) >= 0) {
		const line = buffered.slice(0, nl);
		buffered = buffered.slice(nl + 1);
		if (!line.trim()) continue;
		const m = JSON.parse(line);
		if (!m.method && typeof m.id === 'number' && waiting.has(m.id)) {
			waiting.get(m.id)!(m.error ? { error: m.error } : m.result);
			waiting.delete(m.id);
			continue;
		}
		void f.handle(m, ask).then((r) => r && send(r));
	}
}
