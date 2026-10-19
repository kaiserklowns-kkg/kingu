// UI strings of Local AI (lib/localAi): grey-text completions and semantic search on the user's
// own model server. Keys: 'localAi.<what>'. Thai in ../th/localAi.ts.
export const localAi = {
	// LocalAiStatus.svelte
	'localAi.status.label': 'Local AI',
	'localAi.status.off': 'Completions are off. Click for Local AI.',
	'localAi.status.idle': 'Completions are on ({model}). Click for Local AI.',
	'localAi.status.loading': 'Asking the model…',
	'localAi.status.error': 'Completions failed: {error}',
	'localAi.status.autoModel': 'first coding model',
	'localAi.status.indexing': 'Indexing for semantic search: {done} of {total} files',
	// The status item's menu
	'localAi.menu.placeholder': 'Local AI',
	'localAi.menu.enable': 'Turn On Completions',
	'localAi.menu.disable': 'Turn Off Completions',
	'localAi.menu.search': 'Semantic Search…',
	'localAi.menu.enableSemantic': 'Turn On Semantic Search',
	'localAi.menu.rebuild': 'Rebuild Semantic Index',
	'localAi.menu.settings': 'Local AI Settings',
	// Semantic search
	'localAi.semantic.placeholder': 'Search the workspace by meaning (Thai or English)',
	'localAi.semantic.hint': 'Press Enter to search for “{query}”',
	'localAi.semantic.hintEmpty': 'Type what you are looking for',
	'localAi.semantic.searching': 'Searching by meaning…',
	'localAi.semantic.results': '{count|# result|# results} for “{query}”',
	'localAi.semantic.resultsIndexing': '{count|# result|# results} for “{query}” (still indexing: {done} of {total} files)',
	'localAi.semantic.noResults': 'Nothing related to “{query}” yet',
	'localAi.semantic.failed': 'Semantic search failed: {error}',
	'localAi.semantic.off': 'Semantic search is off. Turn it on in Settings › Local AI.',
	'localAi.semantic.noFolder': 'Open a folder to search it by meaning',
	'localAi.semantic.rebuilding': 'Rebuilding the semantic index…',
	'localAi.semantic.limited': 'The semantic index is full; the least recently changed files are left out',
	'localAi.semantic.ready': 'Semantic index ready: {files} files'
} as const;
