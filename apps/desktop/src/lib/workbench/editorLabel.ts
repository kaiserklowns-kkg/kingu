// Display name of an editor (tab label, window title). The Settings editor, the task board and
// task pages are not workspace files.

import { isBoardKey, slugOfTaskKey } from '#lib/ade/keys.ts';
import { adeTasks } from '#lib/ade/tasks.svelte.ts';
import { SETTINGS_EDITOR_KEY, settings } from '#lib/settings/settings.svelte.ts';
import { untitledFirstLines } from './editorModels';
import { tabLabel } from './scm';
import { customLabel, customLabelPatterns, untitledLabel } from './tabLabels';
import { changesSlug, isChangesKey } from './viewers';
import { isUntitled, untitledName } from './untitled';
import { workspace } from './workspace.svelte';
import { t } from '#lib/i18n/index.ts';
import { parseVaultKey } from '#lib/vault/vault.ts';
import { vault } from '#lib/vault/vault.svelte.ts';
import { chatIdOfEditorKey } from '#lib/agent/chatExtras.ts';
import { chats } from '#lib/agent/chats.svelte.ts';
import { parseArtifactKey } from '#lib/artifacts/artifacts.ts';
import { artifacts } from '#lib/artifacts/artifacts.svelte.ts';
import { isSearchEditorKey, searchEditorName } from './searchEditor';
import { searchEditors } from './searchEditor.svelte.ts';
import { terminalIdOfEditor } from '#lib/terminal/terminalEditor.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';

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
	if (isSearchEditorKey(key)) return searchEditorName(key, searchEditors.peek(key)?.config.query ?? '');
	if (isBoardKey(key)) return t('workbench.editorLabel.board');
	if (isChangesKey(key)) return changesSlug(key) ? t('workbench.editorLabel.changes', { title: adeTasks.find(changesSlug(key))?.meta.title ?? changesSlug(key) ?? '' }) : t('workbench.editorLabel.allChanges');
	const session = parseVaultKey(key);
	if (session) return vault.byPath(session.path)?.title ?? session.path.split('/').pop() ?? key;
	const artifact = parseArtifactKey(key);
	if (artifact) return (artifact.team ? artifacts.team.find((a) => a.artifact_id === artifact.id)?.title : artifacts.list.find((a) => a.id === artifact.id)?.title) ?? t('artifacts.title');
	const chatId = chatIdOfEditorKey(key);
	if (chatId) return chats.get(chatId)?.title ?? t('chat.panel.newChat');
	const terminal = terminalIdOfEditor(key);
	if (terminal !== null) return terminals.get(terminal)?.title ?? 'Terminal';
	const slug = slugOfTaskKey(key);
	if (slug) return t('workbench.editorLabel.task', { title: adeTasks.find(slug)?.meta.title ?? slug });
	return custom(key) ?? tabLabel(key);
}
