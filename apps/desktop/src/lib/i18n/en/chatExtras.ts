// UI strings of the smaller chat features (agent/chatExtras.svelte.ts, ChatList, AgentPanel,
// MemoriesPage, agent/guardText.ts): Kingu's safety asks, thumbs up / down, "Remember this" and
// Settings › Memories, follow-up chips, Open Chat in Editor. Keys: 'chatExtras.<what>'. Thai in
// ../th/chatExtras.ts.
export const chatExtras = {
	'chatExtras.ask.text': 'Kingu asks first: {reason}',
	'chatExtras.ask.withPaths': 'Kingu asks first: {reason} ({paths})',
	'chatExtras.ask.outsideCwd': 'it writes outside the project folder',
	'chatExtras.ask.delete': 'it deletes files',
	'chatExtras.ask.protected': 'it touches a protected file (.kinguignore)',
	'chatExtras.ask.mcp': 'it calls an MCP tool',
	'chatExtras.feedback.helpful': 'Helpful',
	'chatExtras.feedback.unhelpful': 'Not Helpful',
	'chatExtras.feedback.thanks': 'Thanks for the feedback',
	'chatExtras.feedback.failed': 'Could not save the feedback: {error}',
	'chatExtras.remember.label': 'Remember This',
	'chatExtras.remember.hint': 'Remember this (or the selected text) in CLAUDE.local.md or AGENTS.md',
	'chatExtras.remember.where': 'Remember “{text}” in…',
	'chatExtras.remember.local': 'Just for you, read by Claude Code',
	'chatExtras.remember.shared': 'Shared with the project, read by every agent',
	'chatExtras.remember.saved': 'Remembered in {file}',
	'chatExtras.remember.failed': 'Could not remember it: {error}',
	'chatExtras.followups': 'Suggested follow-ups',
	'chatExtras.followupHint': 'Send this follow-up',
	'chatExtras.openInEditor': 'Open Chat in Editor',
	'chatExtras.moveToSideBar': 'Move Chat to Side Bar',
	'chatExtras.editorMissing': 'This chat is not in the open folder.',
	'chatExtras.editorLoading': 'Loading the chat…',
	'chatExtras.memories.title': 'Memories',
	'chatExtras.memories.intro':
		'What "Remember this" saved from chats for this folder: the bullets under "## Memories" in CLAUDE.local.md (only for you) and AGENTS.md (shared with the project). Agents read them at the start of every chat.',
	'chatExtras.memories.refresh': 'Refresh',
	'chatExtras.memories.noFolder': 'Open a folder to see its memories.',
	'chatExtras.memories.openFile': 'Open File',
	'chatExtras.memories.edit': 'Edit Memory',
	'chatExtras.memories.none': 'No memories yet. Use "Remember this" on a chat message.',
	'chatExtras.memories.deleteConfirm': 'Delete this memory?\n\n{text}'
} as const;
