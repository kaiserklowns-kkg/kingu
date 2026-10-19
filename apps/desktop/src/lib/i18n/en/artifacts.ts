// UI strings of Artifacts (lib/artifacts): pages agents publish, their viewer, the side view, the
// chat card, Export and Share with team. Keys: 'artifacts.<what>'. Thai in ../th/artifacts.ts.
export const artifacts = {
	'artifacts.title': 'Artifacts',
	// ArtifactsView.svelte
	'artifacts.filter': 'Filter artifacts',
	'artifacts.refresh': 'Refresh',
	'artifacts.noFolder': 'Open a folder to see its artifacts.',
	'artifacts.empty': 'No artifacts yet. Ask an agent to publish a page (artifact_publish), or run kingu artifact publish <file>.',
	'artifacts.noMatch': 'No artifact matches the filter.',
	'artifacts.loading': 'Loading…',
	'artifacts.loadFailed': 'Could not read the artifacts: {error}',
	'artifacts.byAgent': 'by an agent',
	'artifacts.byCli': 'from the kingu command',
	'artifacts.sharedShort': 'shared',
	'artifacts.team': 'Shared with the team',
	'artifacts.teamEmpty': 'Nobody on the team has shared an artifact yet.',
	'artifacts.teamFailed': 'Could not read the team\'s artifacts: {error}',
	// ArtifactViewer.svelte
	'artifacts.badKey': 'This tab does not name an artifact.',
	'artifacts.version': 'Version',
	'artifacts.reload': 'Reload',
	'artifacts.export': 'Export',
	'artifacts.share': 'Share with team',
	'artifacts.shareNeedsTeam': 'Sign in to a team server first (Settings → Team)',
	'artifacts.delete': 'Delete',
	'artifacts.unshare': 'Remove from the team',
	'artifacts.readOnly': 'read-only',
	'artifacts.sharedBy': 'Shared by {user} · {when}',
	'artifacts.sharedVersion': 'v{version} shared with the team',
	'artifacts.previewFailed': 'Could not show the page: {error}',
	// artifacts.svelte.ts
	'artifacts.exported': 'Exported to {path}',
	'artifacts.exportFailed': 'Could not export the artifact: {error}',
	'artifacts.shareAsk': 'Share "{title}" (version {version}) with your team? Teammates signed in to the team server can open it read-only. Its files are put inside the page and sent to the server, so check it holds nothing private.',
	'artifacts.shareOk': 'Share',
	'artifacts.shared': 'Shared "{title}" with the team',
	'artifacts.shareFailed': 'Could not share the artifact: {error}',
	'artifacts.deleteAsk': 'Delete "{title}" and its {count|# version|# versions} from this project?',
	'artifacts.deleteFailed': 'Could not delete the artifact: {error}',
	'artifacts.unshareAsk': 'Remove "{title}" from the team? Teammates can no longer open it.',
	'artifacts.unshareFailed': 'Could not remove the artifact from the team: {error}',
	// ArtifactCard.svelte
	'artifacts.card.open': 'Open the artifact',
	'artifacts.card.detail': 'Artifact · v{version} · {format}'
} as const;
