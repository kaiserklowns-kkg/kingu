// Source Control with several repositories (multi-root workspaces, nested repositories): the
// Repositories view, the repository picker and the parent folder prompt. Thai in ../th/scmRepos.ts.
export const scmRepos = {
	'scmRepos.repositories': 'Repositories',
	'scmRepos.pickRepository': 'Choose a repository',
	'scmRepos.pickInitFolder': 'Choose Workspace Folder to initialize a Git repo',
	'scmRepos.parentFound': 'A git repository was found in a parent folder of {folder}: {repository}. Open it?',
	'scmRepos.parentOpen': 'Open',
	'scmRepos.parentAlways': 'Always',
	'scmRepos.parentNever': 'Never',
	'scmRepos.changes': '{count|# change|# changes}',
	'scmRepos.sync': 'Synchronize Changes',
	'scmRepos.publish': 'Publish Branch',
	'scmRepos.checkout': 'Checkout Branch/Tag...',
	'scmRepos.commitOn': 'Message ({key} to commit on \'{branch}\')',
	'scmRepos.commitOnIn': 'Message ({key} to commit on \'{branch}\' in {repository})',
	'scmRepos.noRepositories': 'The open folders have no git repository.',
	'scmRepos.toggle': 'Show the changes of {name}',
} as const;
