// VS Code's chat customizations in the chat input (Rust agent/customizations.rs finds the files),
// the pure part so `bun test` covers it:
//   - the mode picker: Agent, Ask, Plan (VS Code's built-in agents) and the folder's custom agents
//     (`*.agent.md`), over the chat's permission mode and its `agent`;
//   - prompt files (`*.prompt.md`) run as `/name args`: the body with its variables filled
//     (`${input:x}` from `x=value` in the args, `${selection}`, `${file}`, `${workspaceFolder}`…),
//     and the agent / model its front matter picks;
//   - typed `#` variables (`#selection`, `#problems`, `#changes`, `#terminalLastCommand`,
//     `#file:path`, `#folder:path`, `#codebase`), resolved when the request is sent.

import type { ChatMode } from './chatInput.ts';
import type { PermissionMode } from './chats.ts';

/** A prompt file (Rust `PromptFile`). */
export type PromptFile = {
	name: string;
	description: string;
	argument_hint: string;
	agent: string | null;
	model: string | null;
	tools: string[];
	path: string;
	rel: string;
	user: boolean;
};

/** A custom agent (Rust `CustomAgent`). */
export type CustomAgent = {
	name: string;
	description: string;
	argument_hint: string;
	model: string | null;
	tools: string[];
	user_invocable: boolean;
	path: string;
	rel: string;
	user: boolean;
};

export type Customizations = { prompts: PromptFile[]; agents: CustomAgent[] };

/** Rust's name for the built-in Ask agent. */
export const ASK_AGENT = 'ask';

// ---- the mode picker -------------------------------------------------------------------------

/** A picker row's value: a built-in agent, or `custom:<name>`. */
export type ModePick = 'agent' | 'ask' | 'plan' | `custom:${string}`;

/** What the picker shows for a chat: its custom agent or Ask, else Plan or Agent by its permission mode. */
export function modePick(permission: PermissionMode | 'bypassPermissions' | null | undefined, agent: string | null | undefined): ModePick {
	if (agent === ASK_AGENT) return 'ask';
	if (agent) return `custom:${agent}`;
	return permission === 'plan' ? 'plan' : 'agent';
}

/**
 * A pick → the chat's mode (`ask` is Plan: the SDK's plan mode) and its agent (null: none). Ask
 * and custom agents run with Agent's approval; their tools decide what they may change.
 */
export function fromPick(pick: ModePick): { mode: ChatMode; agent: string | null } {
	if (pick === 'plan') return { mode: 'ask', agent: null };
	if (pick === 'ask') return { mode: 'agent', agent: ASK_AGENT };
	if (pick.startsWith('custom:')) return { mode: 'agent', agent: pick.slice(7) };
	return { mode: 'agent', agent: null };
}

/** The custom agents the picker lists: user-invocable ones, plus the chat's own even when it is not. */
export function pickerAgents(agents: readonly CustomAgent[], current: string | null | undefined): CustomAgent[] {
	return agents.filter((a) => a.user_invocable || (!!current && a.name.toLowerCase() === current.toLowerCase()));
}

/**
 * The model an agent or prompt file's `model` means for Claude: an SDK alias (`sonnet`, `opus`,
 * `haiku`), a Claude model id as is, or null (inherit, or another vendor's model: the chat keeps its own).
 */
export function claudeModel(model: string | null | undefined): string | null {
	const m = (model ?? '').trim().toLowerCase();
	if (!m || m === 'inherit') return null;
	if (/^claude-[a-z0-9.[\]-]+$/.test(m)) return m;
	for (const alias of ['opus', 'sonnet', 'haiku'] as const) if (m.includes(alias)) return alias;
	return null;
}

/** What a prompt file's `agent` asks for: a pick, or null to keep the chat's (unknown names too). */
export function promptAgentPick(agent: string | null | undefined, agents: readonly CustomAgent[]): ModePick | null {
	const a = (agent ?? '').trim();
	if (!a) return null;
	const lower = a.toLowerCase();
	if (lower === 'agent' || lower === 'ask' || lower === 'plan') return lower;
	// `edit` (VS Code's retired Edit mode) is Agent.
	if (lower === 'edit') return 'agent';
	const found = agents.find((x) => x.name.toLowerCase() === lower);
	return found ? `custom:${found.name}` : null;
}

// ---- prompt files ----------------------------------------------------------------------------

/** What a prompt file's variables can take (VS Code's prompt variables). */
export type PromptVars = {
	/** Workspace-relative path of the active editor's file. */
	file?: string | null;
	selection?: string | null;
	workspaceFolder?: string | null;
};

/**
 * `/name args`: `key=value` words fill `${input:key}` (a quoted value may have spaces); the rest
 * is the user's own text, sent after the prompt.
 */
export function promptArgs(args: string): { inputs: Record<string, string>; rest: string } {
	const inputs: Record<string, string> = {};
	const rest = args.replace(/(^|\s)([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g, (_m, lead: string, key: string, dq?: string, sq?: string, bare?: string) => {
		inputs[key] = dq ?? sq ?? bare ?? '';
		return lead;
	});
	return { inputs, rest: rest.replace(/\s+/g, ' ').trim() };
}

const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

/**
 * A prompt file's body with its variables filled. `${input:x}` / `${input:x:placeholder}` without
 * a value stay as they are: the agent asks for them (VS Code leaves them to the model too).
 */
export function expandPrompt(body: string, inputs: Readonly<Record<string, string>>, vars: PromptVars): string {
	const file = vars.file ?? '';
	const name = base(file);
	const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
	const values: Record<string, string | null | undefined> = {
		file: file || null,
		fileBasename: name || null,
		fileBasenameNoExtension: name ? name.replace(/\.[^.]*$/, '') : null,
		fileDirname: file ? dir || '.' : null,
		selection: vars.selection,
		selectedText: vars.selection,
		workspaceFolder: vars.workspaceFolder,
		workspaceFolderBasename: vars.workspaceFolder ? base(vars.workspaceFolder) : null
	};
	return body.replace(/\$\{(input:([\w-]+)(?::[^}]*)?|[A-Za-z]+)\}/g, (whole, inner: string, input?: string) => {
		if (input !== undefined) return inputs[input] ?? whole;
		const v = values[inner];
		return v === undefined || v === null ? whole : v;
	});
}

/** The request a prompt file sends: a line naming it with the user's text, and the filled prompt as context. */
export function promptRequest(file: Pick<PromptFile, 'name' | 'rel'>, expanded: string, rest: string): { text: string; context: { kind: string; label: string; text: string } } {
	const text = rest ? `Follow the prompt file /${file.name} (attached) for: ${rest}` : `Follow the prompt file /${file.name} (attached).`;
	return { text, context: { kind: 'prompt', label: `/${file.name}`, text: `Prompt file ${file.rel}:\n\n${expanded}` } };
}

// ---- typed # variables -----------------------------------------------------------------------

/** The `#` variables a request may type (VS Code's chat variables). */
export const CHAT_VARIABLES = ['selection', 'problems', 'changes', 'terminalLastCommand', 'codebase'] as const;
export type ChatVariable = (typeof CHAT_VARIABLES)[number];

export type TypedVariable = { kind: ChatVariable } | { kind: 'file' | 'folder'; path: string };

/** The `#` variables in a request's text, each once, in order. `#file:` / `#folder:` take a path. */
export function typedVariables(text: string): TypedVariable[] {
	const out: TypedVariable[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(/(?:^|\s)#(file|folder):(?:`([^`]+)`|"([^"]+)"|(\S+))|(?:^|\s)#([A-Za-z]+)(?=$|[\s.,;:!?)])/g)) {
		const v: TypedVariable | null = m[1]
			? { kind: m[1] as 'file' | 'folder', path: (m[2] ?? m[3] ?? m[4] ?? '').replace(/[.,;:!?)]+$/, '').replace(/^\.\//, '') }
			: (CHAT_VARIABLES as readonly string[]).includes(m[5]) ? { kind: m[5] as ChatVariable } : null;
		if (!v || ('path' in v && !v.path)) continue;
		const key = 'path' in v ? `${v.kind}:${v.path}` : v.kind;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(v);
	}
	return out;
}

// ---- new files -------------------------------------------------------------------------------

export type CustomizationKind = 'prompt' | 'agent' | 'instructions';

/** A name a new file may take: letters, digits, `-`, `_` and `.` (no folders). */
export const validFileName = (name: string): boolean => /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,99}$/u.test(name.trim());

/**
 * Chat: New Prompt File / Custom Agent / Instructions File: the workspace file (VS Code's
 * default folder for each) and its starting text.
 */
export function newCustomizationFile(kind: CustomizationKind, name: string): { rel: string; content: string } {
	const n = name.trim().replace(/\.(prompt|agent|instructions)\.md$|\.md$/, '');
	switch (kind) {
		case 'prompt':
			return { rel: `.github/prompts/${n}.prompt.md`, content: `---\ndescription: ''\nargument-hint: ''\nagent: agent\n---\nDescribe the task. Use \${input:name} for values given as name=value after /${n}, and \${selection} or \${file} for the editor.\n` };
		case 'agent':
			return { rel: `.github/agents/${n}.agent.md`, content: `---\nname: ${n}\ndescription: ''\ntools: ['read', 'search', 'edit', 'execute', 'web']\n---\nDescribe how this agent works and what it returns.\n` };
		case 'instructions':
			return { rel: `.github/instructions/${n}.instructions.md`, content: `---\napplyTo: '**'\ndescription: ''\n---\nInstructions the agent follows for the files that match applyTo.\n` };
	}
}

/** `#codebase`: what it adds for an agent that searches the folder itself. */
export const CODEBASE_HINT = 'The user referenced #codebase: search the whole workspace (Grep, Glob, Read) for everything relevant before answering, and cite the files you used.';
