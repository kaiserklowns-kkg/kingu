// Which surface owns each AI setting (docs/AI-SURFACES.md §4), as data: settingOwners.test.ts
// fails when a `kingu.agent.*` / `kingu.chat.*` setting has no owner here, so a new one is placed
// before it ships. First match wins. Pure.

/** `ide`: the agent chat. `ade`: the task CLIs. `shared`: both read it (the AI core). */
export type SettingOwner = 'ide' | 'ade' | 'shared';

/** `*` stands for one or more dot-separated segments. */
export const SETTING_OWNERS: readonly (readonly [pattern: string, owner: SettingOwner])[] = [
	// IDE chat
	['kingu.agent.runtime', 'ide'],
	['kingu.agent.model', 'ide'],
	['kingu.agent.acpAgents', 'ide'],
	['kingu.agent.antigravityManagedAgy', 'ide'],
	['kingu.agent.antigravityGoogleSignIn', 'ide'],
	['kingu.agent.antigravityChatAuth', 'ide'],
	['kingu.chat.*', 'ide'],
	// ADE task CLIs
	['kingu.agent.cli', 'ade'],
	['kingu.agent.args.*', 'ade'],
	['kingu.agent.env.*', 'ade'],
	['kingu.agent.cmdOverrides', 'ade'],
	['kingu.agent.disabled', 'ade'],
	['kingu.agent.cliPermissions', 'ade'],
	['kingu.agent.claudeAgentTeams', 'ade'],
	['kingu.agent.statusHooks', 'ade'],
	['kingu.agent.hibernation', 'ade'],
	['kingu.agent.hibernationIdleMinutes', 'ade'],
	['kingu.agent.promptCacheTimer', 'ade'],
	['kingu.agent.promptCacheTtl', 'ade'],
	// Both: defaults, trust, policy (§7), notifications
	['kingu.agent.permissionMode', 'shared'],
	['kingu.agent.trustWorkspace', 'shared'],
	['kingu.agent.safetyChecks', 'shared'],
	['kingu.agent.protectedPaths', 'shared'],
	['kingu.agent.ask.*', 'shared'],
	['kingu.agent.notifications', 'shared'],
	['kingu.agent.notifications.*', 'shared']
];

const matcher = (pattern: string) => new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\\\.\*$/, '\\..+')}$`);
const RULES = SETTING_OWNERS.map(([p, owner]) => [matcher(p), owner] as const);

/** The owner of setting `id`; null when it has none (an AI setting must not). */
export function ownerOf(id: string): SettingOwner | null {
	return RULES.find(([re]) => re.test(id))?.[1] ?? null;
}

/** Whether `id` is an AI setting that needs an owner. */
export const isAiSetting = (id: string) => /^kingu\.(agent|chat)\./.test(id);
