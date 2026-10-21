// UI strings of the chat's agent picker (agent/runtimes.ts: Claude Code, Codex, ACP agents).
// Keys: 'chatRuntime.<what>'. Thai in ../th/chatRuntime.ts.
export const chatRuntime = {
	'chatRuntime.label': 'Agent',
	'chatRuntime.hint': 'Which agent runs this chat (agents found on PATH; add ACP agents in kingu.agent.acpAgents)',
	'chatRuntime.current': 'This chat runs on {name}',
	'chatRuntime.missing': '{name} (not found)'
} as const;
