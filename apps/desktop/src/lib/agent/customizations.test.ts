import { describe, expect, test } from 'bun:test';
import { claudeModel, expandPrompt, fromPick, modePick, newCustomizationFile, pickerAgents, validFileName, promptAgentPick, promptArgs, promptRequest, typedVariables, type CustomAgent } from './customizations';

const agent = (name: string, user_invocable = true): CustomAgent => ({ name, description: '', argument_hint: '', model: null, tools: [], user_invocable, path: `/w/.github/agents/${name}.agent.md`, rel: `.github/agents/${name}.agent.md`, user: false });

describe('mode picker', () => {
	test('a chat shows its agent, else Plan or Agent by its permission mode', () => {
		expect(modePick('default', null)).toBe('agent');
		expect(modePick('acceptEdits', undefined)).toBe('agent');
		expect(modePick('bypassPermissions', null)).toBe('agent');
		expect(modePick('plan', null)).toBe('plan');
		expect(modePick('default', 'ask')).toBe('ask');
		expect(modePick('default', 'Planner')).toBe('custom:Planner');
	});

	test('a pick sets the mode and the agent', () => {
		expect(fromPick('agent')).toEqual({ mode: 'agent', agent: null });
		expect(fromPick('plan')).toEqual({ mode: 'ask', agent: null });
		expect(fromPick('ask')).toEqual({ mode: 'agent', agent: 'ask' });
		expect(fromPick('custom:Planner')).toEqual({ mode: 'agent', agent: 'Planner' });
		for (const p of ['agent', 'plan', 'ask', 'custom:x'] as const) {
			const { mode, agent } = fromPick(p);
			expect(modePick(mode === 'ask' ? 'plan' : 'default', agent)).toBe(p);
		}
	});

	test('hidden agents are listed only while the chat uses one', () => {
		const all = [agent('Planner'), agent('helper', false)];
		expect(pickerAgents(all, null).map((a) => a.name)).toEqual(['Planner']);
		expect(pickerAgents(all, 'Helper').map((a) => a.name)).toEqual(['Planner', 'helper']);
	});

	test("an agent's model as Claude's", () => {
		expect(claudeModel('Claude Sonnet 4')).toBe('sonnet');
		expect(claudeModel('opus')).toBe('opus');
		expect(claudeModel('Claude Haiku 4.5 (copilot)')).toBe('haiku');
		expect(claudeModel('claude-opus-4-1')).toBe('claude-opus-4-1');
		expect(claudeModel('GPT-4o')).toBeNull();
		expect(claudeModel('inherit')).toBeNull();
		expect(claudeModel(null)).toBeNull();
	});

	test("a prompt file's agent", () => {
		const all = [agent('Planner')];
		expect(promptAgentPick('ask', all)).toBe('ask');
		expect(promptAgentPick('Agent', all)).toBe('agent');
		expect(promptAgentPick('edit', all)).toBe('agent');
		expect(promptAgentPick('plan', all)).toBe('plan');
		expect(promptAgentPick('planner', all)).toBe('custom:Planner');
		expect(promptAgentPick('gone', all)).toBeNull();
		expect(promptAgentPick(null, all)).toBeNull();
	});
});

describe('prompt files', () => {
	test('key=value args fill inputs, the rest is the user text', () => {
		expect(promptArgs('formName=MyForm fields="name, email" for the signup page')).toEqual({ inputs: { formName: 'MyForm', fields: 'name, email' }, rest: 'for the signup page' });
		expect(promptArgs("x='a b'")).toEqual({ inputs: { x: 'a b' }, rest: '' });
		expect(promptArgs('just text, a=b=c')).toEqual({ inputs: { a: 'b=c' }, rest: 'just text,' });
		expect(promptArgs('')).toEqual({ inputs: {}, rest: '' });
	});

	test('variables are filled; unknown inputs stay for the agent', () => {
		const body = 'Make ${input:formName} with ${input:fields:the fields}.\nIn ${file} (${fileBasename}, ${fileBasenameNoExtension}, ${fileDirname}) of ${workspaceFolderBasename}:\n${selection}\n${env:HOME}';
		expect(expandPrompt(body, { formName: 'Signup' }, { file: 'src/ui/Form.tsx', selection: 'const a = 1;', workspaceFolder: '/Users/me/app' })).toBe(
			'Make Signup with ${input:fields:the fields}.\nIn src/ui/Form.tsx (Form.tsx, Form, src/ui) of app:\nconst a = 1;\n${env:HOME}'
		);
		expect(expandPrompt('${file} ${selection} ${fileDirname}', {}, { file: 'a.ts' })).toBe('a.ts ${selection} .');
	});

	test('the request names the prompt file and attaches it', () => {
		const r = promptRequest({ name: 'review', rel: '.github/prompts/review.prompt.md' }, 'Review the diff.', 'the auth module');
		expect(r.text).toBe('Follow the prompt file /review (attached) for: the auth module');
		expect(r.context).toEqual({ kind: 'prompt', label: '/review', text: 'Prompt file .github/prompts/review.prompt.md:\n\nReview the diff.' });
		expect(promptRequest({ name: 'x', rel: 'x' }, 'y', '').text).toBe('Follow the prompt file /x (attached).');
	});
});

describe('new customization files', () => {
	test('VS Code’s folders and a starting text', () => {
		expect(newCustomizationFile('prompt', 'review').rel).toBe('.github/prompts/review.prompt.md');
		expect(newCustomizationFile('agent', 'planner.agent.md').rel).toBe('.github/agents/planner.agent.md');
		expect(newCustomizationFile('instructions', 'py').content).toContain("applyTo: '**'");
		expect(newCustomizationFile('prompt', 'x').content).toContain('${input:name}');
		expect(validFileName('รีวิว-1')).toBe(true);
		expect(validFileName('../x')).toBe(false);
		expect(validFileName('a b')).toBe(false);
	});
});

describe('typed # variables', () => {
	test('known names and file paths, once each', () => {
		expect(typedVariables('fix #problems in #file:src/a.ts, then #changes. #selection #problems')).toEqual([
			{ kind: 'problems' },
			{ kind: 'file', path: 'src/a.ts' },
			{ kind: 'changes' },
			{ kind: 'selection' }
		]);
		expect(typedVariables('#terminalLastCommand failed; see #folder:`src/my dir` and #codebase')).toEqual([
			{ kind: 'terminalLastCommand' },
			{ kind: 'folder', path: 'src/my dir' },
			{ kind: 'codebase' }
		]);
	});

	test('other # words are left alone', () => {
		expect(typedVariables('issue #123 and C# and a#problems and #unknown and #file:')).toEqual([]);
	});
});
