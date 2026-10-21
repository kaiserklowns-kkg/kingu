import { describe, expect, test } from 'bun:test';
import { applyEvent, initialRun, type McpRequestEvent } from './events';
import { buildTurns } from './chatParts';
import { mergeCommands } from './slashCommands';
import {
	expandTemplate,
	findPromptCommand,
	formContent,
	formFields,
	initialValues,
	missingArgs,
	parsePromptArgs,
	promptCommand,
	promptText,
	resourceContext,
	samplingWith,
	templateVars
} from './mcpChat';
import { MAX_INLINE_BYTES } from './chatPrompt';

const FORM = {
	type: 'object',
	properties: {
		title: { type: 'string', title: 'Title', minLength: 2 },
		priority: { type: 'string', enum: ['low', 'high'], enumNames: ['Low', 'High'], default: 'low' },
		size: { oneOf: [{ const: 's', title: 'Small' }, { const: 'l' }] },
		count: { type: 'integer', minimum: 1, maximum: 9 },
		ratio: { type: 'number' },
		email: { type: 'string', format: 'email' },
		urgent: { type: 'boolean', default: true }
	},
	required: ['title', 'count']
};

const request = (over: Partial<McpRequestEvent> = {}): McpRequestEvent => ({
	kind: 'mcp_request',
	request_id: 'm1',
	type: 'elicitation',
	server: 'tickets',
	message: 'New ticket',
	mode: 'form',
	schema: FORM,
	url: null,
	sampling: null,
	timeout_ms: 600_000,
	...over
});

describe('MCP forms', () => {
	test('fields from the restricted schema: labels, options, defaults, required', () => {
		const fields = formFields(FORM)!;
		expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
			['title', 'string', true],
			['priority', 'string', false],
			['size', 'string', false],
			['count', 'integer', true],
			['ratio', 'number', false],
			['email', 'string', false],
			['urgent', 'boolean', false]
		]);
		expect(fields[0]).toMatchObject({ label: 'Title', min: 2 });
		expect(fields[1]!.options).toEqual([
			{ value: 'low', label: 'Low' },
			{ value: 'high', label: 'High' }
		]);
		expect(fields[2]!.options).toEqual([
			{ value: 's', label: 'Small' },
			{ value: 'l', label: 'l' }
		]);
		expect(initialValues(fields)).toEqual({ title: '', priority: 'low', size: '', count: '', ratio: '', email: '', urgent: true });
		// A field the card cannot show: no form (Decline / Cancel only).
		expect(formFields({ type: 'object', properties: { tags: { type: 'array' } } })).toBeNull();
		expect(formFields(null)).toBeNull();
	});

	test('the answer: typed values, numbers as numbers, empty optional fields left out, errors per field', () => {
		const fields = formFields(FORM)!;
		const values = { ...initialValues(fields), title: ' Crash ', count: '3', ratio: '0.5', urgent: false };
		expect(formContent(fields, values)).toEqual({ content: { title: 'Crash', priority: 'low', count: 3, ratio: 0.5, urgent: false } });
		expect(formContent(fields, initialValues(fields))).toEqual({ errors: { title: 'required', count: 'required' } });
		expect(formContent(fields, { ...values, title: 'x', count: '2.5', email: 'nope' })).toEqual({ errors: { title: 'minLength', count: 'integer', email: 'email' } });
		expect(formContent(fields, { ...values, count: '10' })).toEqual({ errors: { count: 'max' } });
		expect(formContent(fields, { ...values, ratio: 'abc' })).toEqual({ errors: { ratio: 'number' } });
	});
});

describe('MCP asks in the run', () => {
	test('a form waits (status waiting), its answer is kept, the card becomes a line', () => {
		const s = initialRun();
		applyEvent(s, { kind: 'message', role: 'user', text: 'go' });
		applyEvent(s, request());
		expect(s.status).toBe('waiting');
		expect(s.mcpPending?.map((p) => p.request_id)).toEqual(['m1']);
		let turns = buildTurns(s);
		expect(turns[0]!.parts).toEqual([{ kind: 'mcpRequest', request: request() }]);
		applyEvent(s, { kind: 'mcp_request_resolved', request_id: 'm1', action: 'accept' });
		expect(s.status).toBe('running');
		expect(s.mcpPending).toEqual([]);
		turns = buildTurns(s);
		expect(turns[0]!.parts).toEqual([{ kind: 'mcpRequest', request: request(), action: 'accept' }]);
	});

	test('a result keeps the chat waiting while a server still asks; the exit cancels it', () => {
		const s = initialRun();
		applyEvent(s, request({ request_id: 'm2', type: 'sampling', schema: null, mode: null }));
		applyEvent(s, { kind: 'result', subtype: 'success', is_error: false, result: 'x', session_id: null, num_turns: 1, duration_ms: 1, total_cost_usd: null });
		expect(s.status).toBe('waiting');
		applyEvent(s, { kind: 'exit', code: 0, signal: null, stopped: false });
		expect(s.mcpActions).toEqual({ m2: 'cancel' });
		expect(s.mcpPending).toEqual([]);
	});
});

describe('sampling setting', () => {
	test('Always / Never write allowedDuringChat for the server, keeping the rest', () => {
		expect(samplingWith(undefined, 'web', true)).toEqual({ web: { allowedDuringChat: true } });
		expect(samplingWith({ web: { allowedModels: ['m'] }, db: { allowedDuringChat: true } }, 'web', false)).toEqual({ web: { allowedModels: ['m'], allowedDuringChat: false }, db: { allowedDuringChat: true } });
		expect(samplingWith([1], 'x', true)).toEqual({ x: { allowedDuringChat: true } });
	});
});

describe('MCP prompts as / commands', () => {
	const args = [
		{ name: 'file', description: 'Which file', required: true },
		{ name: 'tone', description: '', required: false }
	];

	test('command names (VS Code’s), found in the input with what follows', () => {
		expect(promptCommand('my server', 'code review!')).toBe('mcp.my_server.code_review_');
		const known = [{ command: 'mcp.notes.review' }];
		expect(findPromptCommand('/mcp.notes.review a.ts kind', known)).toEqual({ item: known[0]!, args: 'a.ts kind' });
		expect(findPromptCommand('/mcp.notes.other', known)).toBeNull();
		expect(findPromptCommand('mcp.notes.review', known)).toBeNull();
		const merged = mergeCommands([], [], [], [], [{ name: 'mcp.notes.review', description: 'Review', argumentHint: '<file>', source: 'mcp' }]);
		expect(merged.map((m) => [m.name, m.source])).toEqual([['mcp.notes.review', 'mcp']]);
	});

	test('arguments: name=value pairs, else in order (the last takes the rest); the missing ones', () => {
		expect(parsePromptArgs('file=a.ts tone="very kind"', args)).toEqual({ file: 'a.ts', tone: 'very kind' });
		expect(parsePromptArgs('a.ts very kind', args)).toEqual({ file: 'a.ts', tone: 'very kind' });
		expect(parsePromptArgs('', args)).toEqual({});
		expect(parsePromptArgs('nope=1', args)).toEqual({ file: 'nope=1' });
		expect(missingArgs(args, { file: 'a.ts' }).map((a) => a.name)).toEqual(['tone']);
	});

	test('a rendered prompt: messages joined (roles marked when they differ), embedded resources attached', () => {
		const one = promptText({ description: '', messages: [{ role: 'user', text: 'Review a.ts' }, { role: 'user', text: 'Be kind' }], resources: [], images: 0 }, (u) => u);
		expect(one).toEqual({ text: 'Review a.ts\n\nBe kind', context: [] });
		const two = promptText(
			{
				description: '',
				messages: [
					{ role: 'user', text: 'Q' },
					{ role: 'assistant', text: 'A' }
				],
				resources: [
					{ uri: 'memo://style', mimeType: 'text/plain', text: 'style guide', bytes: 11, truncated: false },
					{ uri: 'file:///x.png', mimeType: 'image/png', text: null, bytes: 6, truncated: false }
				],
				images: 0
			},
			(u) => `${u} (notes)`
		);
		expect(two.text).toBe('--USER\nQ\n\n--ASSISTANT\nA');
		expect(two.context).toEqual([{ kind: 'mcp-resource', label: 'memo://style (notes)', text: 'style guide' }]);
	});
});

describe('MCP resources', () => {
	test('templates: variables and expansion', () => {
		expect(templateVars('memo://notes/{topic}{?page,size}')).toEqual(['topic', 'page', 'size']);
		expect(expandTemplate('memo://notes/{topic}', { topic: 'a b/c' })).toBe('memo://notes/a%20b%2Fc');
		expect(expandTemplate('file://{+path}', { path: '/a b/c' })).toBe('file:///a%20b/c');
		expect(expandTemplate('x://q{?page,size}', { page: '2' })).toBe('x://q?page=2');
		expect(expandTemplate('x://{/a,b}', { a: '1', b: '2' })).toBe('x:///1/2');
	});

	test('a resource as attached context, cut like other attached text; binary content is not', () => {
		const big = 'x'.repeat(MAX_INLINE_BYTES * 2);
		const ctx = resourceContext({ uri: 'memo://big', mimeType: 'text/plain', text: big, bytes: big.length, truncated: false }, 'big (notes)')!;
		expect(ctx.kind).toBe('mcp-resource');
		expect(ctx.text.length).toBeLessThan(big.length);
		expect(resourceContext({ uri: 'f', mimeType: 'image/png', text: null, bytes: 3, truncated: false }, 'f')).toBeNull();
	});
});
