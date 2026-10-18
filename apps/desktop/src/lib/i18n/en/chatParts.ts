// UI strings of the chat response parts (agent/ChatTodoBar, ChatToolRow, ChatEditPill,
// ChatRequestChanges, code block actions in ChatMarkdown). Keys: 'chatParts.<what>'. Thai in
// ../th/chatParts.ts.
export const chatParts = {
	// Todo list above the input (VS Code's ChatTodoListWidget)
	'chatParts.todos.label': 'Chat todo list',
	'chatParts.todos.title': 'Todos',
	'chatParts.todos.titleCount': 'Todos ({n}/{total})',
	'chatParts.todos.current': '{title} ({n}/{total})',
	'chatParts.todos.expand': 'Expand Todos',
	'chatParts.todos.collapse': 'Collapse Todos',
	'chatParts.todos.item': '{title}, {status}',
	'chatParts.todos.completed': 'completed',
	'chatParts.todos.inProgress': 'in progress',
	'chatParts.todos.notStarted': 'not started',
	'chatParts.todos.updating': 'Updating todos',
	'chatParts.todos.updated': 'Updated todos',
	// Plan card (ExitPlanMode)
	'chatParts.plan.title': 'Plan',
	// Edited-file pills and the per-request summary
	'chatParts.edit.open': 'Open the changes to {path}',
	'chatParts.changes.files': '{count|# file|# files} changed',
	'chatParts.changes.viewAll': 'View All File Changes',
	'chatParts.changes.toggle': 'Show or hide the changed files',
	// Subagents (Task / Agent)
	'chatParts.subagent.tools': '{count|# tool call|# tool calls}',
	'chatParts.subagent.pending': '{count|# pending confirmation|# pending confirmations}',
	'chatParts.subagent.prompt': 'Prompt',
	'chatParts.subagent.result': 'Result',
	// Code block actions
	'chatParts.code.newFile': 'Insert into New File',
	'chatParts.code.terminal': 'Insert into Terminal',
	'chatParts.code.noTerminal': 'Open a folder to use the terminal',
	'chatParts.code.newFileFailed': 'Could not put the code in a new file'
} as const;
