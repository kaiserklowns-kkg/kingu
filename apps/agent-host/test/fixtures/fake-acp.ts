// A fake ACP agent for the tests (runtimes/acp.ts): speaks ACP version 1 over stdio, never calls
// a model. Each received method is logged to stderr as `got <method>` (the run's `stderr` events).
// Prompts drive it:
//   "edit <file>"  an edit tool call with a diff, a permission request, then writes the file itself
//   "run <cmd>"    an execute tool call and a permission request (nothing runs)
//   "wait"         streams a chunk and waits for `session/cancel`
//   anything else  "echo: <text>"
// FAKE_ACP_AUTH=1: `session/new` fails with "auth required".
// FAKE_ACP_AUTH=google: offers `oauth-personal`; `session/new` fails with "auth required" until
//   `authenticate`, which prints Google's sign-in link (on stdout as Antigravity's server does,
//   and after the BROWSER helper's marker on stderr) and succeeds (FAKE_ACP_AUTH_FAIL=1: fails).
// FAKE_ACP_AUTH=key: Antigravity's server with a Gemini API key account: offers its three methods;
//   `session/new` fails with "auth required" until `authenticate` with `gemini-api-key`, which
//   succeeds only when GEMINI_API_KEY is set (no link is printed).
// "notice <text>" (prompt): the whole reply is <text>, then the turn ends normally.
// FAKE_ACP_AUTH=file:<path>: `session/new` fails with "auth required" until <path> exists
//   (a login made elsewhere, as in a terminal).
// A `session/new` with `_meta` logs `meta <json>`.
// FAKE_ACP_THOUGHT=1: the session advertises a `thought_level` config option (Low / Medium /
// High / Extra High); `session/set_config_option` is logged as `got session/set_config_option <value>`.
// FAKE_ACP_LEGACY_MODEL=1: models only in the older `models.availableModels` field of `session/new`;
// `session/set_model` is logged as `got session/set_model <modelId>`.
// Dialect tests (acpDialects.test.ts):
// FAKE_ACP_MODES=a,b,c: a `mode` config option (id `permission`) with these values, the first
//   current (FAKE_ACP_MODE_STUCK=1: a write leaves it as it was).
// FAKE_ACP_SESSION_MODES=a,b: these session modes instead of default / yolo.
// FAKE_ACP_COMMANDS=a,b: these commands instead of `init`.
// FAKE_ACP_PROMPT_ERROR=<json>: every prompt fails with this JSON-RPC error.
//   "ask <toolCallId>"  a permission request for that tool call id
//   "call <method>"     the agent's own request; the reply is logged as `reply <json>`

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let next = 0;
const waiting = new Map<number, (v: any) => void>();
let cancel: (() => void) | null = null;

const send = (msg: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const update = (sessionId: string, u: object) => send({ method: 'session/update', params: { sessionId, update: u } });
const request = (method: string, params: object) =>
	new Promise<any>((resolve) => {
		const id = ++next;
		waiting.set(id, resolve);
		send({ id, method, params });
	});

const SESSION = 'acp-sess-1';
const AUTH = process.env.FAKE_ACP_AUTH ?? '';
let signedIn = false;
const SIGN_IN_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F&response_type=code&state=s1';
const needsSignIn = () => AUTH === '1' || ((AUTH === 'google' || AUTH === 'key') && !signedIn) || (AUTH.startsWith('file:') && !existsSync(AUTH.slice(5)));

async function prompt(sessionId: string, text: string) {
	update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'คิดก่อน' } });
	const edit = /^edit (\S+)/.exec(text);
	const run = /^run (.+)/.exec(text);
	if (edit) {
		const path = join(process.cwd(), edit[1]!);
		update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'กำลังแก้' } });
		update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: `Edit ${edit[1]}`, kind: 'edit', status: 'pending', content: [{ type: 'diff', path, oldText: 'old\n', newText: 'new\n' }], locations: [{ path }] });
		const r = await request('session/request_permission', {
			sessionId,
			toolCall: { toolCallId: 'call-1' },
			options: [
				{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
				{ optionId: 'always', name: 'Always', kind: 'allow_always' },
				{ optionId: 'no', name: 'Reject', kind: 'reject_once' }
			]
		});
		const ok = r.outcome?.outcome === 'selected' && r.outcome.optionId !== 'no';
		process.stderr.write(`permission ${r.outcome?.outcome}:${r.outcome?.optionId ?? ''}\n`);
		if (ok) writeFileSync(path, 'new\n');
		update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: ok ? 'edited' : 'rejected' } }] });
		update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'แก้ไฟล์', priority: 'high', status: 'completed' }, { content: 'ทดสอบ', priority: 'low', status: 'pending' }] });
		update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'เสร็จ' } });
		update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000 });
		return { stopReason: 'end_turn' };
	}
	if (run) {
		update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: run[1], kind: 'execute', status: 'pending', rawInput: { command: run[1] } });
		const r = await request('session/request_permission', {
			sessionId,
			toolCall: { toolCallId: 'call-2' },
			options: [
				{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
				{ optionId: 'no', name: 'Reject', kind: 'reject_once' }
			]
		});
		process.stderr.write(`permission ${r.outcome?.outcome}:${r.outcome?.optionId ?? ''}\n`);
		const ok = r.outcome?.optionId === 'yes';
		update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: ok ? 'completed' : 'failed', rawOutput: { output: ok ? 'ran' : '' } });
		return { stopReason: 'end_turn' };
	}
	const notice = /^notice ([\s\S]+)/.exec(text);
	if (notice) {
		update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: notice[1] } });
		return { stopReason: 'end_turn' };
	}
	const ask = /^ask (\S+)/.exec(text);
	if (ask) {
		const r = await request('session/request_permission', {
			sessionId,
			toolCall: { toolCallId: ask[1], title: 'Which one?', kind: 'other', status: 'pending' },
			options: [
				{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
				{ optionId: 'no', name: 'Reject', kind: 'reject_once' }
			]
		});
		process.stderr.write(`permission ${r.outcome?.outcome}:${r.outcome?.optionId ?? ''}\n`);
		return { stopReason: 'end_turn' };
	}
	const own = /^call (\S+)/.exec(text);
	if (own) {
		const r = await request(own[1]!, { sessionId });
		process.stderr.write(`reply ${JSON.stringify(r ?? null)}\n`);
		return { stopReason: 'end_turn' };
	}
	if (text === 'wait') {
		update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
		await new Promise<void>((resolve) => (cancel = resolve));
		return { stopReason: 'cancelled' };
	}
	update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } });
	return { stopReason: 'end_turn' };
}

const modelOption = () => ({ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake-model', options: [{ value: 'fake-model', name: 'Fake' }, { value: 'alt-model', name: 'Alt' }] });

const thoughtOption = (current: string) => ({
		id: 'reasoning',
		name: 'Reasoning',
		category: 'thought_level',
		type: 'select',
		currentValue: current,
		options: [
			{ value: 'low', name: 'Low' },
			{ value: 'medium', name: 'Medium' },
			{ value: 'high', name: 'High' },
			{ value: 'extra_high', name: 'Extra High' }
		]
	});

const list = (name: string) => (process.env[name] ?? '').split(',').filter(Boolean);
let modeCurrent = list('FAKE_ACP_MODES')[0] ?? '';
const modeOption = () => ({ id: 'permission', name: 'Permissions', category: 'mode', type: 'select', currentValue: modeCurrent, options: list('FAKE_ACP_MODES').map((value) => ({ value, name: value })) });

const configOptions = () => [
	...(process.env.FAKE_ACP_MODEL === '1' ? [modelOption()] : []),
	...(process.env.FAKE_ACP_THOUGHT === '1' ? [thoughtOption('medium')] : []),
	...(list('FAKE_ACP_MODES').length ? [modeOption()] : [])
];

async function handle(msg: any) {
	if (msg.method) process.stderr.write(`got ${msg.method}${msg.method === 'session/set_mode' ? ` ${msg.params.modeId}` : msg.method === 'session/set_model' ? ` ${msg.params.modelId}` : msg.method === 'session/set_config_option' ? ` ${msg.params.configId}=${msg.params.value}` : ''}\n`);
	if (msg.id !== undefined && !msg.method) return waiting.get(msg.id)?.(msg.result);
	switch (msg.method) {
		case 'initialize':
			return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: AUTH === 'google' ? [{ id: 'oauth-personal', name: 'Sign in with Google' }] : AUTH === 'key' ? ['oauth-personal', 'gemini-api-key', 'agent-platform'].map((id) => ({ id, name: id })) : [] } });
		case 'authenticate':
			if (AUTH === 'key') {
				process.stderr.write(`authenticate ${msg.params?.methodId}\n`);
				if (msg.params?.methodId !== 'gemini-api-key' || !process.env.GEMINI_API_KEY) return send({ id: msg.id, error: { code: -32603, message: 'GEMINI_API_KEY is not set' } });
				signedIn = true;
				return send({ id: msg.id, result: {} });
			}
			if (AUTH !== 'google' || msg.params?.methodId !== 'oauth-personal') return send({ id: msg.id, error: { code: -32602, message: 'unknown method' } });
			process.stdout.write(`Open the following link to authenticate the ACP server: ${SIGN_IN_URL}\n`);
			process.stderr.write(`__KINGU_ANTIGRAVITY_AUTH_URL__${SIGN_IN_URL}\n`);
			await new Promise((r) => setTimeout(r, 100));
			if (process.env.FAKE_ACP_AUTH_FAIL === '1') return send({ id: msg.id, error: { code: -32603, message: 'Google sign-in was cancelled' } });
			signedIn = true;
			return send({ id: msg.id, result: {} });
		case 'session/new':
			if (msg.params?._meta) process.stderr.write(`meta ${JSON.stringify(msg.params._meta)}\n`);
			if (needsSignIn()) return send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });
			send({
				id: msg.id,
				result: {
					sessionId: SESSION,
					modes: list('FAKE_ACP_SESSION_MODES').length
						? { currentModeId: list('FAKE_ACP_SESSION_MODES')[0], availableModes: list('FAKE_ACP_SESSION_MODES').map((id) => ({ id, name: id })) }
						: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'YOLO' }] },
					models: {
						currentModelId: 'fake-model',
						availableModels: process.env.FAKE_ACP_LEGACY_MODEL === '1' ? [{ modelId: 'fake-model', name: 'Fake' }, { modelId: 'alt-model', name: 'Alt', description: 'the other' }] : []
					},
					...(configOptions().length ? { configOptions: configOptions() } : {})
				}
			});
			update(SESSION, {
				sessionUpdate: 'available_commands_update',
				availableCommands: list('FAKE_ACP_COMMANDS').length ? list('FAKE_ACP_COMMANDS').map((name) => ({ name, description: name, input: null })) : [{ name: 'init', description: 'Write GEMINI.md', input: null }]
			});
			return;
		case 'session/load':
			// History replay: the client must not show it again.
			update(msg.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
			update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
			return send({ id: msg.id, result: null });
		case 'session/set_mode':
			return send({ id: msg.id, result: null });
		case 'session/set_config_option':
			if (msg.params.configId === 'permission' && process.env.FAKE_ACP_MODE_STUCK !== '1') modeCurrent = msg.params.value;
			return send({ id: msg.id, result: { configOptions: configOptions().map((o) => (o.id === msg.params.configId && o.id !== 'permission' ? { ...o, currentValue: msg.params.value } : o)) } });
		case 'session/set_model':
			return send({ id: msg.id, result: null });
		case 'session/prompt': {
			if (process.env.FAKE_ACP_PROMPT_ERROR) return send({ id: msg.id, error: JSON.parse(process.env.FAKE_ACP_PROMPT_ERROR) });
			// The skill index Kingu puts first (src/skills.ts) is logged, not echoed.
			if (msg.params.prompt.some((b: any) => b.type === 'text' && b.text.startsWith('# Skills'))) process.stderr.write('got skills\n');
			const text = msg.params.prompt
				.filter((b: any) => b.type === 'text' && !b.text.startsWith('# Skills'))
				.map((b: any) => b.text)
				.join('');
			return send({ id: msg.id, result: await prompt(msg.params.sessionId, text) });
		}
		case 'session/cancel':
			cancel?.();
			cancel = null;
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
		if (line.trim()) void handle(JSON.parse(line));
	}
}
