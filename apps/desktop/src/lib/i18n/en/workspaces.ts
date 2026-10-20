// UI strings of files outside the folder, `.code-workspace` files and Open Recent
// (workbench/workspace.svelte.ts). Keys: 'workspaces.<what>'. Thai in ../th/workspaces.ts.
export const workspaces = {
	'workspaces.openFileTitle': 'Open File',
	'workspaces.openFileFailed': 'Could not open the file: {error}',
	'workspaces.openWorkspaceTitle': 'Open Workspace from File',
	'workspaces.readFailed': 'Could not read the workspace file {name}: {error}',
	'workspaces.noFolders': '{name} lists no folders on this computer.',
	'workspaces.pickFolder': '{name} has {count} folders; Kingu opens one folder per window. Pick the folder to open',
	'workspaces.addFolder': 'Kingu opens one folder per window, so a folder cannot be added to this one. Open {name} instead?',
	'workspaces.openInstead': 'Open Folder',
	'workspaces.saveFailed': 'Could not save the workspace file: {error}',
	'workspaces.saved': 'Saved {name}. Open it with Open Workspace from File.',
	'workspaces.recentFolders': 'folders & workspaces',
	'workspaces.recentFiles': 'files',
	'workspaces.workspaceSuffix': '{name} (Workspace)',
	'workspaces.removeRecent': 'Remove from Recently Opened'
} as const;
