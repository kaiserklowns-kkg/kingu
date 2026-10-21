// A fake `codex app-server` for the tests (runtimes/codex.ts): JSON-RPC lines without the
// "jsonrpc" member, never calls a model. Each received method is logged to stderr as
// `got <method>` (thread/start and thread/resume with their approval policy and sandbox, and
// `+skills` with a skill index as developer instructions).
// Prompts drive it:
//   "edit <file>"  a fileChange item, its approval, then writes the file itself
//   "run <cmd>"    a commandExecution item and its approval (nothing runs)
//   "wait"         waits for `turn/interrupt`
//   anything else  "echo: <text>"

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let next = 0;
let turns = 0;
const waiting = new Map<number, (v: any) => void>();
let interrupt: (() => void) | null = null;

const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method: string, params: object) => send({ method, params });
const request = (method: string, params: object) =>
	new Promise<any>((resolve) => {
		const id = ++next;
		waiting.set(id, resolve);
		send({ id, method, params });
	});

const THREAD = 'thr-fake-1';

async function turn(turnId: string, text: string) {
	const edit = /^edit (\S+)/.exec(text);
	const run = /^run (.+)/.exec(text);
	notify('turn/started', { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } });
	notify('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'คิดก่อน' });
	let status = 'completed';
	if (edit) {
		const path = join(process.cwd(), edit[1]!);
		const item = { type: 'fileChange', id: 'fc1', changes: [{ path, kind: { type: 'update' }, diff: '-old\n+new' }], status: 'inProgress' };
		notify('item/started', { threadId: THREAD, turnId, item });
		const r = await request('item/fileChange/requestApproval', { threadId: THREAD, turnId, itemId: 'fc1', reason: null });
		process.stderr.write(`decision ${r.decision}\n`);
		const ok = r.decision === 'accept' || r.decision === 'acceptForSession';
		if (ok) writeFileSync(path, 'new\n');
		notify('item/completed', { threadId: THREAD, turnId, item: { ...item, status: ok ? 'completed' : 'declined' } });
		notify('turn/plan/updated', { threadId: THREAD, turnId, plan: [{ step: 'แก้ไฟล์', status: 'completed' }, { step: 'ทดสอบ', status: 'inProgress' }] });
	} else if (run) {
		const item = { type: 'commandExecution', id: `cmd-${turnId}`, command: run[1], cwd: process.cwd(), status: 'inProgress' };
		notify('item/started', { threadId: THREAD, turnId, item });
		const r = await request('item/commandExecution/requestApproval', { threadId: THREAD, turnId, itemId: `cmd-${turnId}`, command: run[1], reason: 'needs the network' });
		process.stderr.write(`decision ${r.decision}\n`);
		const ok = r.decision === 'accept' || r.decision === 'acceptForSession';
		notify('item/completed', { threadId: THREAD, turnId, item: { ...item, status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'ran' : '', exitCode: ok ? 0 : null } });
	} else if (text === 'wait') {
		await new Promise<void>((resolve) => (interrupt = resolve));
		status = 'interrupted';
	}
	if (status === 'completed') {
		const answer = edit ? 'เสร็จ' : run ? 'done' : `echo: ${text}`;
		notify('item/started', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'm1', text: '' } });
		notify('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'm1', delta: answer });
		notify('item/completed', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'm1', text: answer } });
		notify('thread/tokenUsage/updated', {
			threadId: THREAD,
			turnId,
			tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 900 }, modelContextWindow: 272000 }
		});
	}
	notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status, error: null } });
}

function handle(msg: any) {
	if (msg.method) {
		const p = msg.params ?? {};
		const policy = msg.method === 'thread/start' || msg.method === 'thread/resume' ? ` ${p.approvalPolicy} ${p.sandbox}${typeof p.developerInstructions === 'string' && p.developerInstructions.startsWith('# Skills') ? ' +skills' : ''}` : msg.method === 'turn/start' ? ` ${p.approvalPolicy}` : '';
		process.stderr.write(`got ${msg.method}${policy}${msg.jsonrpc ? ' (with jsonrpc)' : ''}\n`);
	}
	if (msg.id !== undefined && !msg.method) return waiting.get(msg.id)?.(msg.result);
	switch (msg.method) {
		case 'initialize':
			return send({ id: msg.id, result: { userAgent: 'fake-codex/0.0.0' } });
		case 'initialized':
			return;
		case 'thread/start':
			return send({ id: msg.id, result: { thread: { id: THREAD }, model: 'gpt-fake' } });
		case 'thread/resume':
			if (msg.params.threadId !== THREAD) return send({ id: msg.id, error: { code: -32600, message: 'no rollout found' } });
			return send({ id: msg.id, result: { thread: { id: THREAD }, model: 'gpt-fake' } });
		case 'turn/start': {
			const id = `turn-${++turns}`;
			send({ id: msg.id, result: { turn: { id, status: 'inProgress', items: [] } } });
			const text = msg.params.input
				.filter((b: any) => b.type === 'text')
				.map((b: any) => b.text)
				.join('');
			void turn(id, text);
			return;
		}
		case 'turn/interrupt':
			send({ id: msg.id, result: {} });
			interrupt?.();
			interrupt = null;
			return;
		default:
			if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
	}
}

const decoder = new TextDecoder();
let buffered = '';
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let nl: number;
	while ((nl = buffered.indexOf('\n')) >= 0) {
		const line = buffered.slice(0, nl);
		buffered = buffered.slice(nl + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
}
