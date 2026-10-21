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
	'chatToolRules.approvedByMany': 'Auto approved by rules {rules}'
} as const;
