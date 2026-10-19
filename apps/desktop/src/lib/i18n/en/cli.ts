// UI strings of the `kingu` command (lib/ade/cliBridge.svelte.ts): its requests and the
// Install/Uninstall shell command. Keys: 'cli.<what>'. Thai in ../th/cli.ts.
export const cli = {
	'cli.installAsk': 'Install the kingu command in {dir} so terminals and agents outside Kingu can control the app (start tasks, open files, notify)?',
	'cli.installOk': 'Install',
	'cli.installed': 'Installed the kingu command: {path}',
	'cli.installedNotOnPath': 'Installed the kingu command: {path}. {dir} is not on your shell\'s PATH yet; add it to use kingu outside Kingu.',
	'cli.installFailed': 'Could not install the kingu command: {error}',
	'cli.uninstalled': 'Removed the kingu command: {paths}',
	'cli.notInstalled': 'The kingu command is not installed in PATH',
	'cli.uninstallFailed': 'Could not remove the kingu command: {error}',
	'cli.noFolder': 'No folder is open in Kingu',
	'cli.outsideFolder': '{path} is not in the folder open in Kingu; open its folder first (kingu open <folder>)',
	'cli.folderNotOpened': 'Kingu did not open {path}',
	'cli.taskNotCreated': 'The task was not created (see Kingu\'s notifications)',
	'cli.unknownRequest': 'Unknown request: {method}'
} as const;
