// UI strings of the added projects of the Agents side bar (projects.svelte.ts, AdeSidebar.svelte,
// agentNotify.svelte.ts). Keys: 'adeProjects.<what>'. Thai in ../th/adeProjects.ts.
export const adeProjects = {
	'adeProjects.add': 'Add Project…',
	'adeProjects.pickTitle': 'Add Project',
	'adeProjects.added': '{name} added to the side bar',
	'adeProjects.already': '{name} is already in the side bar',
	'adeProjects.addFailed': 'Could not add the project: {error}',
	'adeProjects.removed': '{name} removed from the side bar',
	'adeProjects.removeFailed': 'Could not remove the project: {error}',
	'adeProjects.loadFailed': 'Could not read this project: {error}',
	'adeProjects.open': 'Open Project',
	'adeProjects.remove': 'Remove Project',
	'adeProjects.menu': 'Project actions',
	'adeProjects.actionsFor': 'Project actions for {name}',
	'adeProjects.openTask': 'Open {task} (switches to {project})',
	'adeProjects.noTasks': 'No tasks',
	'adeProjects.noticeTask': '{task} · {project}'
} as const;
