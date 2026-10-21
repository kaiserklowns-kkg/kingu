// The VS Code part of the system settings page as VS Code's settings table of contents
// (settingsLayout.ts tocData): Commonly Used, then Text Editor, Workbench, Window, Features,
// Application and Extensions, each holding Kingu's settings groups. A node shows all its groups;
// its children are the groups and the VS Code sub-groups of a group (registry.ts SUBGROUPS).

import { subgroupsOf, tocKey, type SettingSchema } from './registry';

/** VS Code's COMMONLY_USED_SETTINGS (the ones Kingu has), in its order. */
export const COMMONLY_USED: readonly string[] = [
	'editor.fontSize',
	'editor.formatOnSave',
	'files.autoSave',
	'editor.fontFamily',
	'editor.wordWrap',
	'files.exclude',
	'workbench.colorTheme',
	'editor.tabSize',
	'editor.mouseWheelZoom',
	'editor.formatOnPaste'
];

export type TocNode = { id: string; label: string; groups: readonly string[] };

/** The top-level nodes; a Kingu group not listed here stays in its own registry section. */
export const VSCODE_TOC: readonly TocNode[] = [
	{ id: 'editor', label: 'Text Editor', groups: ['Text Editor', 'Diff Editor', 'Files'] },
	{ id: 'workbench', label: 'Workbench', groups: ['Workbench', 'Zen Mode', 'Status Bar'] },
	{ id: 'window', label: 'Window', groups: ['Window'] },
	{
		id: 'features',
		label: 'Features',
		groups: ['Accessibility', 'Explorer', 'Search', 'Debug', 'Testing', 'Source Control', 'Terminal', 'Tasks', 'Problems', 'Output', 'Timeline', 'Merge Conflict']
	},
	{ id: 'application', label: 'Application', groups: ['Application', 'Team', 'Snap Sandbox'] },
	{ id: 'extensions', label: 'Extensions', groups: ['Git', 'TypeScript', 'CSS', 'HTML', 'JSON', 'Emmet'] }
];

/** The selections of the VS Code part: `@vs:commonlyUsed`, `@vs:<node>`. */
export const VS_PREFIX = '@vs:';
export const COMMONLY_USED_ID = 'commonlyUsed';

/** The groups a node holds that have settings (others are left out of the table of contents). */
export const nodeGroups = (node: TocNode, schemas: SettingSchema[]) => node.groups.filter((g) => schemas.some((s) => s.group === g));

/**
 * A node's children in the table of contents, as selections the editor understands: a node of
 * one group lists that group's VS Code sub-groups (Window › New Window); a node of several lists
 * its first group's sub-groups (Text Editor › Cursor …), then its other groups (Diff Editor, Files).
 */
export function tocChildren(node: TocNode, schemas: SettingSchema[]): { key: string; label: string }[] {
	const [first, ...rest] = nodeGroups(node, schemas);
	if (!first) return [];
	const subs = subgroupsOf(first, schemas).map((sub) => ({ key: tocKey(first, sub), label: sub }));
	return [...subs, ...rest.map((g) => ({ key: g, label: g }))];
}
