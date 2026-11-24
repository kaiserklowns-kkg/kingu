// UI strings of VS Code's tool approval rules in the agent chat: the "Always allow" buttons of a
// permission card, the "Auto approved by rule" line of a tool row and the edit-rule safety ask
// (agent/PermissionCard.svelte, agent/ChatToolRow.svelte, agent/toolRules.ts).
// Keys: 'chatToolRules.<what>'. Thai in ../th/chatToolRules.ts.
export const chatToolRules = {
	'chatToolRules.ask.editRule': 'it edits a file you approve edits to (chat.tools.edits.autoApprove)',
	'chatToolRules.allow.commands': 'Always allow {commands}',
	'chatToolRules.allow.commandsHint': 'Adds {keys} to chat.tools.terminal.autoApprove in your user settings and runs this command',
	'chatToolRules.allow.domain': 'Always allow {domain}',
	'chatToolRules.allow.domainHint': 'Adds {keys} to chat.tools.urls.autoApprove in your user settings and fetches this page',
	'chatToolRules.saveFailed': 'Could not save the rule: {error}',
	'chatToolRules.approvedBy': 'Auto approved by rule {rules}',
	'chatToolRules.assistedApproved': 'Approved by Assisted permissions: {reason}',
	'chatToolRules.assistedAsked': 'Assisted permissions asks you: {reason}',
	'chatToolRules.assistedUnavailable': 'The Assisted reviewer could not decide, so it asks you: {reason}',
	'chatToolRules.approvedByMany': 'Auto approved by rules {rules}',
	'chatToolRules.ask.sandboxRetry': 'the sandbox blocked the command, and it can run again once you allow what it needed',
	'chatToolRules.sandbox.session': 'Allow for This Session',
	'chatToolRules.sandbox.sessionHint': 'Adds it to the sandbox of this chat\'s run only, then runs the command again in the sandbox',
	'chatToolRules.sandbox.user': 'Allow for This User',
	'chatToolRules.sandbox.userHint': 'Saves it to {setting} in your user settings, then runs the command again in the sandbox',
	'chatToolRules.sandbox.skip': 'Skip',
	'chatToolRules.sandbox.skipHint': 'Do not change the sandbox; the agent is told the command stays blocked',
	'chatToolRules.sandbox.blockedBy': 'Blocked by',
	'chatToolRules.sandbox.saveFailed': 'Could not save to your settings: {error}'
} as const;
