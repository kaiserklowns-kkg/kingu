// The Markdown preview commands (VS Code's markdown-language-features): Open Preview, Open Preview
// to the Side, Open Locked Preview to the Side, Toggle Preview Locking, Open Source File.
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { hasPreview, isMarkdownPath, isPreviewKey, previewKey, previewTarget } from '#lib/workbench/viewers.ts';
import { t } from '#lib/i18n/index.ts';
import { previewLocks } from './previewLocks.svelte.ts';

const canPreview = () => !appMode.isAgents && editors.active !== null && hasPreview(editors.active);
const activeMarkdownPreview = () => !appMode.isAgents && editors.active !== null && isPreviewKey(editors.active) && isMarkdownPath(previewTarget(editors.active));

function previewToSide(lock: boolean) {
	const rel = editors.active!;
	const key = previewKey(rel);
	if (lock && isMarkdownPath(rel)) previewLocks.set(key, true);
	const side = editors.split('right');
	if (side === null) return editors.open(key, { preview: false });
	// The split copies the Markdown tab; the side group shows only the preview.
	editors.open(key, { preview: false, group: side });
	editors.close(rel, { group: side });
}

export function registerMarkdownPreviewCommands(): () => void {
	const all = [
		commands.register({
			id: 'markdown.showPreview',
			title: 'Open Preview (Markdown, CSV)',
			category: 'Markdown',
			key: 'cmd+shift+v',
			when: canPreview,
			run: () => editors.open(previewKey(editors.active!), { preview: false })
		}),
		commands.register({
			id: 'markdown.showPreviewToSide',
			title: 'Open Preview to the Side (Markdown, CSV)',
			category: 'Markdown',
			key: 'cmd+k v',
			when: canPreview,
			run: () => previewToSide(false)
		}),
		commands.register({
			id: 'markdown.showLockedPreviewToSide',
			title: 'Open Locked Preview to the Side',
			category: 'Markdown',
			when: () => canPreview() && isMarkdownPath(editors.active!),
			run: () => previewToSide(true)
		}),
		commands.register({
			id: 'markdown.preview.toggleLock',
			title: 'Toggle Preview Locking',
			category: 'Markdown',
			when: activeMarkdownPreview,
			run: () => {
				const key = editors.active!;
				const locked = previewLocks.toggle(key);
				status.flash(locked ? t('markdownPreview.locked', { name: previewTarget(key) }) : t('markdownPreview.unlocked'), 3000);
			}
		}),
		commands.register({
			id: 'markdown.showSource',
			title: 'Open Source File',
			category: 'Markdown',
			when: activeMarkdownPreview,
			run: () => {
				const rel = previewTarget(editors.active!);
				const current = editors.activeGroupId;
				const other = editors.model.groups.find((g) => g.id !== current && g.tabs.some((tab) => tab.path === rel))?.id;
				if (other === undefined) return editors.openToSide(rel);
				editors.open(rel, { preview: false, group: other });
				editors.focusGroup(other);
			}
		})
	];
	return () => all.forEach((d) => d());
}
