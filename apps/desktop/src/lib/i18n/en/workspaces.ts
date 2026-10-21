// UI strings of files outside the folder, `.code-workspace` files, multi-root workspaces, New
// Window and Open Recent (workbench/workspace.svelte.ts). Keys: 'workspaces.<what>'. Thai in ../th/workspaces.ts.
export const workspaces = {
	'workspaces.openFileTitle': 'Open File',
	'workspaces.openFileFailed': 'Could not open the file: {error}',
	'workspaces.openWorkspaceTitle': 'Open Workspace from File',
	'workspaces.readFailed': 'Could not read the workspace file {name}: {error}',
	'workspaces.noFolders': '{name} lists no folders on this computer.',
	'workspaces.missingFolders': '{name}: {count} of its folders are not on this computer and were left out.',
	'workspaces.openFolderTitle': 'Open Folder',
	'workspaces.addFolderTitle': 'Add Folder to Workspace',
	'workspaces.addFailed': 'Could not add the folder: {error}',
	'workspaces.removeFailed': 'Could not remove the folder from the workspace: {error}',
	'workspaces.newWindowFailed': 'Could not open a new window: {error}',
	'workspaces.removeFolderPick': 'Select the workspace folder to remove',
	'workspaces.untitled': 'Untitled (Workspace)',
	'workspaces.saveFailed': 'Could not save the workspace file: {error}',
	'workspaces.saved': 'Saved {name}. Open it with Open Workspace from File.',
	'workspaces.recentFolders': 'folders & workspaces',
	'workspaces.recentFiles': 'files',
	'workspaces.workspaceSuffix': '{name} (Workspace)',
	'workspaces.removeRecent': 'Remove from Recently Opened'
} as const;
