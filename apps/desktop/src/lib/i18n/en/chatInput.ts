// UI strings of the chat input's run controls (agent/SlashSuggest.svelte, agent/Composer.svelte's send menu,
// agent/ContextRing.svelte, agent/PermissionCard.svelte's approval scopes, the queue rows and
// "Allow all" in agent/AgentPanel.svelte). Keys: 'chatInput.<what>'. Thai in ../th/chatInput.ts.
export const chatInput = {
	'chatInput.slash.list': 'Commands',
	'chatInput.slash.hint': '↑↓ to choose · Enter or Tab to complete · Esc to close',
	'chatInput.slash.clear': 'Start a new chat',
	'chatInput.slash.model': 'Choose the model',
	'chatInput.slash.fork': 'Fork this chat into a new one',
	'chatInput.slash.source.kingu': 'Kingu',
	'chatInput.slash.source.session': 'Claude Code',
	'chatInput.slash.source.project': 'This folder',
	'chatInput.slash.source.user': 'Yours',
	'chatInput.slash.source.projectSkill': 'Skill · this folder',
	'chatInput.slash.source.userSkill': 'Skill · yours',

	'chatInput.send.queue': 'Add to Queue',
	'chatInput.send.queueHint': 'Queue this message to send after the current turn ends',
	'chatInput.send.steer': 'Steer with Message',
	'chatInput.send.steerHint': 'Send this message now: the agent reads it at its next opportunity',
	'chatInput.send.stop': 'Stop and Send',
	'chatInput.send.stopHint': 'Stop the current turn, then send this message',
	'chatInput.send.more': 'More send actions',

	'chatInput.queue.edit': 'Edit',
	'chatInput.queue.editHint': 'Move this message back into the input',
	'chatInput.queue.sendNow': 'Send Immediately',
	'chatInput.queue.sendNowHint': 'Send this message now, steering the running turn',

	'chatInput.perm.allowOnce': 'Allow Once',
	'chatInput.perm.more': 'More ways to allow',
	'chatInput.perm.session': 'Allow in this Session',
	'chatInput.perm.sessionHint': 'Until this chat’s session ends',
	'chatInput.perm.workspace': 'Allow in this Workspace',
	'chatInput.perm.workspaceHint': 'Saved in this folder’s .claude/settings.local.json (not committed)',
	'chatInput.perm.user': 'Always Allow',
	'chatInput.perm.userHint': 'In every folder: saved in your Claude settings (~/.claude/settings.json)',
	'chatInput.perm.rules': 'Rule: {rules}',
	'chatInput.perm.wholeTool': 'Rule: every {tool} call',
	'chatInput.perm.command': 'Command',

	'chatInput.allowAll': 'Allow all',
	'chatInput.allowAllConfirm':
		'Allow all runs every tool call without asking, shell commands and file edits included, until you pick another level. It applies to this chat until Kingu quits. Continue?',
	'chatInput.allowAllNote': 'Allow all: tools run without asking',

	'chatInput.ctx.label': 'Context window: {percent}% used',
	'chatInput.ctx.title': 'Context Window',
	'chatInput.ctx.used': '{used} / {max} tokens ({percent}%)',
	'chatInput.ctx.cost': 'Session cost: {cost}',
	'chatInput.ctx.warn': 'Quality may decline as the limit nears. Compact to summarize the conversation so far.',
	'chatInput.ctx.compact': 'Compact',
	'chatInput.ctx.compactHint': 'Send /compact: the agent summarizes the conversation to free up the window'
} as const;
