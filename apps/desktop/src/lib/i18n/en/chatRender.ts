// UI strings of the chat's rendering and input extras (agent/ChatMarkdown.svelte math and
// mermaid, ChatReferences.svelte, chatSettings.ts pastes, Composer's microphone, the title bar's
// chat progress badge). Keys: 'chatRender.<what>'. Thai in ../th/chatRender.ts.
export const chatRender = {
	'chatRender.pasted': 'Pasted text ({count|# line|# lines})',
	'chatRender.references': 'Used {count|# reference|# references}',
	'chatRender.referencesList': 'References',
	'chatRender.referenceOpen': 'Open {path}',
	'chatRender.mermaid.label': 'Mermaid diagram',
	'chatRender.mermaid.source': 'Show Source',
	'chatRender.mermaid.diagram': 'Show Diagram',
	'chatRender.mermaid.drawing': 'Drawing the diagram…',
	'chatRender.mermaid.failed': 'Could not draw the diagram: {error}',
	'chatRender.thinking.expand': 'Show all of the thinking',
	'chatRender.voice.start': 'Dictate (Speech to Text)',
	'chatRender.voice.stop': 'Stop Dictation',
	'chatRender.voice.listening': 'Listening… {time}',
	'chatRender.voice.transcribing': 'Transcribing…',
	'chatRender.badge': 'An agent chat is working'
} as const;
