// UI strings of the agent chat composer, Cursor's agent input (agent/Composer.svelte,
// agent/ComposerMenu.svelte, agent/ComposerQueue.svelte, agent/composer.ts, the toolbar row of
// agent/ChatEditsBar.svelte, agent/PermissionCard.svelte's Skip / Run, the bottom bar of
// agent/AgentPanel.svelte). Keys: 'composer.<what>'. Thai in ../th/composer.ts.
export const composer = {
	'composer.placeholder.agent': 'Plan, search, build anything',
	'composer.placeholder.followUp': 'Add a follow-up',
	'composer.placeholder.ask': 'Ask, learn, brainstorm',
	'composer.placeholder.askFollowUp': 'Ask a follow-up question',
	'composer.placeholder.plan': 'Plan changes',
	'composer.placeholder.planFollowUp': 'Refine the plan',
	'composer.placeholder.custom': 'Message {name}',
	'composer.placeholder.customFollowUp': 'Add a follow-up for {name}',
	'composer.placeholder.running': 'Queue a follow-up (sent when this turn ends)',
	'composer.placeholder.pending': 'Reject, suggest, follow up?',
	'composer.placeholder.editingQueued': 'Editing queued message…',

	'composer.mode.label': 'Mode: {mode}',
	'composer.mode.hint': 'Switch mode ({key} or ⇧Tab)',
	'composer.mode.footer': '{key} or ⇧Tab switches to the next mode',
	'composer.mode.agentHint': 'Plan, search, make edits, run commands',
	'composer.mode.askHint': 'Answer questions without making edits',
	'composer.mode.planHint': 'Read the code and propose a plan first',

	'composer.model.label': 'Model: {model}',
	'composer.model.hint': 'Model: {model} ({key})',
	'composer.model.search': 'Search models',
	'composer.model.default': 'Default',

	'composer.options.label': 'Chat options',
	'composer.options.hint': 'Runs on {runtime} in {where} · {run}',

	'composer.run.title': 'Run Mode',
	'composer.run.ask': 'Ask Every Time',
	'composer.run.askHint': 'Asks before tools that are not on your allowlist',
	'composer.run.edits': 'Auto-Accept Edits',
	'composer.run.editsHint': 'File edits go ahead; commands still ask',
	'composer.run.all': 'Run Everything',
	'composer.run.allHint': 'Every tool runs without asking, commands included',
	'composer.run.global': 'Global auto-approve is on',

	'composer.menu.search': 'Search',
	'composer.menu.none': 'Nothing found',

	'composer.slash.skills': 'Skills',
	'composer.slash.commands': 'Commands',
	'composer.slash.modes': 'Modes',
	'composer.slash.actions': 'Actions',
	'composer.slash.source.mode': 'Mode',
	'composer.slash.modeSwitch': 'Switch to {mode}',

	'composer.mention.recent': 'Recent files',
	'composer.mention.context': 'Context',
	'composer.mention.files': 'Files & Folders',
	'composer.mention.back': 'Back to all context',

	'composer.send.queueTitle': '{action} (⏎) · {alt} the other way · {stop} stops and sends · right-click for more',
	'composer.drop': 'Drop files to attach',

	'composer.status.label': 'Agent status',
	'composer.status.running': 'Generating',
	'composer.status.waiting': 'Waiting for Approval',
	'composer.status.edited': '{count|# file|# files} edited',

	'composer.review.review': 'Review',
	'composer.review.reviewHint': 'Open the diff of every changed file',
	'composer.review.confirm': 'Confirm',
	'composer.review.confirmHint': 'Click again to confirm undo',

	'composer.queue.title': '{count} Queued',
	'composer.queue.edit': 'Edit queued message',
	'composer.queue.steer': 'Steer',
	'composer.queue.steerHint': 'Steer: sends now without interrupting the agent',
	'composer.queue.sendNow': 'Send Now',
	'composer.queue.sendNowHint': 'Send Now: stops the agent, then sends this message',
	'composer.queue.interrupt': 'Interrupt: stop the agent and send',
	'composer.queue.remove': 'Remove from queue',
	'composer.queue.more': 'More actions',
	'composer.queue.moveUp': 'Move Up',
	'composer.queue.moveDown': 'Move Down',
	'composer.queue.drag': 'Drag to reorder',
	'composer.editingQueued': 'Editing queued message',

	'composer.approve.run': 'Run',
	'composer.approve.skip': 'Skip',
	'composer.approve.skipHint': 'Skip this call (deny it); the agent is told',
	'composer.approve.reason': 'Skip with a reason…',
	'composer.approve.reasonHint': 'Tell the agent why this call is skipped',
	'composer.approve.allowlistTool': 'Always allow {tool}',
	'composer.approve.allowlistMany': 'Allowlist {count|# rule|# rules}'
} as const;
