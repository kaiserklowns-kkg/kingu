// UI strings of agent browser use (workbench/agentBrowser.svelte.ts, BrowserSurface.svelte): the
// tab's agent indicator, Stop, Share with Agent (VS Code's words), the action log and Add
// Screenshot to Chat. Keys: 'agentBrowser.<what>', and Add Context's Browser Screenshot
// ('chatContext.*'). Thai in ../th/agentBrowser.ts.
export const agentBrowser = {
	'agentBrowser.statusLabel': 'Agent browser use',
	'agentBrowser.driving': 'An agent is driving this page',
	'agentBrowser.drivingAction': 'Agent: {action}',
	'agentBrowser.shared': 'Shared with agents: they can read and use this page, with its cookies',
	'agentBrowser.agentPage': 'Opened by an agent, in storage of its own (not your logins)',
	'agentBrowser.stopped': 'Agents were stopped on this page',
	'agentBrowser.stop': 'Stop',
	'agentBrowser.stopTitle': 'Stop agents from using this page',
	'agentBrowser.share': 'Share with Agent',
	'agentBrowser.unshare': 'Stop Sharing with Agent',
	'agentBrowser.shareTitle': 'Share with Agent?',
	'agentBrowser.shareMessage': 'Share this browser page with the agent? The agent will be able to read and modify browser content and saved data, including cookies. Pages may contain hidden prompts that can influence agent behavior.',
	'agentBrowser.shareOk': 'Share',
	'agentBrowser.log': 'Log',
	'agentBrowser.logEmpty': 'No agent steps on this page yet',
	'agentBrowser.logPick': 'What agents did on this page (Kingu keeps it until you quit)',
	'agentBrowser.replay': 'Replay {count} steps on this page',
	'agentBrowser.copyJson': 'Copy log as JSON',
	'agentBrowser.copied': 'Copied the log',
	'agentBrowser.replayed': 'Replayed {done} of {count} steps',
	'agentBrowser.replayFailed': 'Replay stopped: {error}',
	'agentBrowser.screenshot': 'Add Screenshot to Chat',
	'agentBrowser.screenshotFailed': 'Could not take a screenshot of the page',
	'agentBrowser.screenshotAdded': 'Screenshot added to the chat',
	'chatContext.source.browserScreenshot': 'Browser Screenshot',
	'chatContext.sourceHint.browserScreenshot': 'A picture of an open browser tab',
	'chatContext.none.browserScreenshot': 'No browser tab is open',
	'chatContext.pickBrowser': 'Pick a browser tab',
	'composer.mention.source.browserScreenshot': 'Browser Screenshot',
	// An agent on an SSH host using Kingu's browser (ade/sshBrowserRelay.ts, Rust ssh_browser_relay.rs).
	'agentBrowser.ssh.openTitle': 'Open Browser Page for an SSH Agent?',
	'agentBrowser.ssh.openMessage': 'An agent running on {host} wants to open {url} in Kingu\'s browser on your computer. It will be able to read and interact with the page. The page has storage of its own, not your logins.',
	'agentBrowser.ssh.navigateTitle': 'Navigate Browser for an SSH Agent?',
	'agentBrowser.ssh.navigateMessage': 'An agent running on {host} wants to load {url} in a browser page on your computer and read its contents.',
	'agentBrowser.ssh.allowOnce': 'Allow Once',
	'agentBrowser.ssh.allowRun': 'Allow for This Run',
	'agentBrowser.ssh.deny': 'Deny'
} as const;
