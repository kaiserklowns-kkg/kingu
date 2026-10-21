// UI strings of workflow statuses and the task board (workflow.ts, Board.svelte), session
// continuation and hand-off (sessionHistory.ts, worktreeMenu.svelte.ts), worktree removal in the
// background, the dock badge and resumed chats. Keys: 'adeWorkflow.<what>'. Thai in ../th/adeWorkflow.ts.
export const adeWorkflow = {
	// workflow.ts: Orca's default workspace statuses
	'adeWorkflow.todo': 'Todo',
	'adeWorkflow.inProgress': 'In progress',
	'adeWorkflow.inReview': 'In review',
	'adeWorkflow.done': 'Done',
	// Board.svelte
	'adeWorkflow.board.title': 'Task Board',
	'adeWorkflow.board.count': '{count} tasks',
	'adeWorkflow.board.newTask': 'New Task',
	'adeWorkflow.board.cleanUp': 'Clean Up Tasks',
	'adeWorkflow.board.cleanUpTitle': 'Clean up finished tasks (Clean Up Tasks)',
	'adeWorkflow.board.refresh': 'Refresh',
	'adeWorkflow.board.empty': 'No tasks',
	'adeWorkflow.board.dropHere': 'Drop here',
	'adeWorkflow.board.columns': 'Columns',
	'adeWorkflow.board.byWorkflow': 'Workflow',
	'adeWorkflow.board.byWorkflowTitle': 'Columns you move tasks between: Todo, In progress, In review, Done (kingu.board.statuses)',
	'adeWorkflow.board.byAgent': 'Agent status',
	'adeWorkflow.board.byAgentTitle': 'Columns from what the agent is doing: needs you, working, done',
	'adeWorkflow.board.cardTitle': '{title}: drag to another column to change its status',
	// AdeSidebar.svelte: Group by
	'adeWorkflow.groupBy': 'Workflow',
	// worktreeActions.ts / worktreeMenu.svelte.ts
	'adeWorkflow.action.moveStatus': 'Move to Status…',
	'adeWorkflow.action.continueSession': 'Continue Session…',
	'adeWorkflow.action.handOff': 'Hand Off to Another Agent…',
	'adeWorkflow.pick.status': 'Status for {title}',
	'adeWorkflow.pick.statusCurrent': 'current',
	'adeWorkflow.pick.session': 'Session of {title} to continue',
	'adeWorkflow.pick.sessionLatest': 'latest',
	'adeWorkflow.pick.sessionResume': 'resume with {agent}',
	'adeWorkflow.pick.sessionHandOff': '{agent} cannot resume it: hand it off with its transcript',
	'adeWorkflow.pick.noSessions': '{title} has no saved agent sessions yet',
	'adeWorkflow.pick.handOffSession': 'Session of {title} to hand off',
	'adeWorkflow.pick.agent': 'Agent to continue the session',
	'adeWorkflow.pick.agentCurrent': 'the task’s agent',
	'adeWorkflow.pick.noAgents': 'No agent CLI found on the PATH (Agent: Choose CLI…)',
	// tasks.svelte.ts
	'adeWorkflow.moved': 'Moved {title} to {status}',
	'adeWorkflow.nextMessageResumes': 'The next message continues session {id}',
	'adeWorkflow.resuming': 'Continuing session {id} in {agent}',
	'adeWorkflow.handedOff': 'Handed {title} to {agent}',
	'adeWorkflow.stopFirst': 'Stop the agent of {title} first',
	'adeWorkflow.removing': 'Removing…',
	'adeWorkflow.alreadyRemoving': '{slug} is already being removed',
	'adeWorkflow.orphanAsk': 'Git no longer tracks the worktree folder {path}, but the folder is still there (a removal stopped halfway, or git lost track of it). Delete the folder and everything in it?',
	'adeWorkflow.orphanTitle': 'Leftover Worktree Folder',
	'adeWorkflow.orphanOk': 'Delete Folder',
	// chatResume.svelte.ts
	'adeWorkflow.chatsResumed': 'Continued {count} chats that were working when Kingu quit'
} as const;
