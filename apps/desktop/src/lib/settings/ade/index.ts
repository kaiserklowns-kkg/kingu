// The ADE's Orca settings as `kingu.*` keys, one file per Orca settings page. Each array is
// spread into the registry's SETTINGS; the groups below are the ADE section's table of contents
// (system-wide ones go in the System section). Orca → Kingu mapping: ./orcaMap.ts.

import type { SettingSchema } from '../registry';
import { AGENT_SETTINGS } from './agents';
import { APPEARANCE_SETTINGS } from './appearance';
import { GIT_SETTINGS } from './git';
import { REPO_SETTINGS } from './repo';
import { SIDEBAR_SETTINGS } from './sidebar';
import { TERMINAL_SETTINGS } from './terminal';

export const ADE_SETTINGS: SettingSchema[] = [...AGENT_SETTINGS, ...REPO_SETTINGS, ...SIDEBAR_SETTINGS, ...TERMINAL_SETTINGS, ...GIT_SETTINGS, ...APPEARANCE_SETTINGS];

/**
 * The AI Capabilities section's groups (Orca's AI Capabilities: its Agents pane is the Agent
 * group; Local AI is Kingu's own). The section's pages are in registry.ts.
 */
export const AI_SECTION_GROUPS = ['Agent', 'Local AI'];

/** The ADE section's groups, in Orca's settings page order. */
export const ADE_SECTION_GROUPS = ['Agent Chat', 'Notifications', 'Worktrees', 'Repository', 'ADE Sidebar', 'ADE Terminal', 'Source Control AI', 'Pull Requests'];

/** Groups of the System section that come from Orca's Appearance / General pages. */
export const SYSTEM_SECTION_GROUPS = ['Appearance'];
