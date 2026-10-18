// UI strings of agent chat edits inside the code editor (agent/chatEditDecorations.svelte.ts):
// the Keep / Undo bar of each change and the file's overlay. Keys: 'chatEditor.<what>'. Thai in
// ../th/chatEditor.ts.
export const chatEditor = {
	'chatEditor.keepHunk': 'Keep this Change',
	'chatEditor.undoHunk': 'Undo this Change',
	'chatEditor.keepFile': 'Keep Chat Edits in this File',
	'chatEditor.undoFile': 'Undo Chat Edits in this File',
	'chatEditor.next': 'Go to Next Chat Edit',
	'chatEditor.previous': 'Go to Previous Chat Edit',
	'chatEditor.position': '{index} of {count}',
	'chatEditor.changes': '{count|# change|# changes}',
	'chatEditor.overlay': 'Agent changes in this file',
	'chatEditor.running': 'Keep and Undo wait until the agent finishes this turn',
	'chatEditor.kept': 'Kept the change',
	'chatEditor.undone': 'Undid the change'
} as const;
