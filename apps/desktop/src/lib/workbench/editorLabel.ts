// Display name of an editor (tab label, window title). The Settings editor, the task board and
// task pages are not workspace files.

import { isBoardKey, slugOfTaskKey } from '#lib/ade/keys.ts';
import { adeTasks } from '#lib/ade/tasks.svelte.ts';
import { SETTINGS_EDITOR_KEY, settings } from '#lib/settings/settings.svelte.ts';
import { untitledFirstLines } from './editorModels';
import { tabLabel } from './scm';
import { customLabel, customLabelPatterns, untitledLabel } from './tabLabels';
import { isUntitled, untitledName } from './untitled';
import { workspace } from './workspace.svelte';

const compiled = new WeakMap<object, ReturnType<typeof customLabelPatterns>>();

/** `workbench.editor.customLabels.*`: the custom name of a workspace file, or undefined. */
function custom(key: string): string | undefined {
	if (key.includes(':') || !workspace.root || !settings.get<boolean>('workbench.editor.customLabels.enabled')) return undefined;
	const map = settings.get<Record<string, string>>('workbench.editor.customLabels.patterns');
	if (!map || !Object.keys(map).length) return undefined;
	let patterns = compiled.get(map);
	if (!patterns) compiled.set(map, (patterns = customLabelPatterns(map)));
	return customLabel(key, workspace.root, patterns);
}

export function editorLabel(key: string): string {
	if (key === SETTINGS_EDITOR_KEY) return 'Settings';
	if (isUntitled(key)) return untitledLabel(untitledName(key), untitledFirstLines.get(key) ?? '', settings.get<'content' | 'name'>('workbench.editor.untitled.labelFormat'));
	if (isBoardKey(key)) return 'บอร์ดงาน';
	const slug = slugOfTaskKey(key);
	if (slug) return `งาน: ${adeTasks.find(slug)?.meta.title ?? slug}`;
	return custom(key) ?? tabLabel(key);
}
