// Display name of an editor (tab label, window title). The Settings editor, the task board and
// task pages are not workspace files.

import { isBoardKey, slugOfTaskKey } from '#lib/ade/keys.ts';
import { adeTasks } from '#lib/ade/tasks.svelte.ts';
import { SETTINGS_EDITOR_KEY } from '#lib/settings/settings.svelte.ts';
import { tabLabel } from './scm';
import { changesSlug, isChangesKey } from './viewers';

export function editorLabel(key: string): string {
	if (key === SETTINGS_EDITOR_KEY) return 'Settings';
	if (isBoardKey(key)) return 'บอร์ดงาน';
	if (isChangesKey(key)) return changesSlug(key) ? `การเปลี่ยนแปลง: ${adeTasks.find(changesSlug(key))?.meta.title ?? changesSlug(key)}` : 'การเปลี่ยนแปลงทั้งหมด';
	const slug = slugOfTaskKey(key);
	if (slug) return `งาน: ${adeTasks.find(slug)?.meta.title ?? slug}`;
	return tabLabel(key);
}
