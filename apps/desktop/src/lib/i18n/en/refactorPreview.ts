// UI strings of the Refactor Preview panel (lsp/RefactorPreviewView.svelte). Keys: 'refactorPreview.<what>'. Thai in ../th/refactorPreview.ts.
export const refactorPreview = {
	'refactorPreview.title': 'Refactor Preview',
	'refactorPreview.apply': 'Apply',
	'refactorPreview.discard': 'Discard',
	'refactorPreview.empty': 'No refactoring is waiting to be applied.',
	'refactorPreview.summary': '{edits|# change|# changes} in {files|# file|# files}',
	'refactorPreview.toggle': 'Include changes of {name}',
	'refactorPreview.toggleEdit': 'Include this change',
	'refactorPreview.line': 'line {line}',
	'refactorPreview.collapse': 'Collapse',
	'refactorPreview.expand': 'Expand',
	'refactorPreview.diffLabel': '{name} (Refactor Preview)',
	'refactorPreview.renameLabel': "Rename to '{name}'"
} as const;
