// The Output view's commands (VS Code: output.contribution.ts) and View: Maximize Panel Size.
// Palette titles are VS Code's English ones.

import { t } from '#lib/i18n/index.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { panelSize } from '#lib/workbench/panelSize.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { output } from './output.svelte';
import { LOG_LEVELS, type LogLevel } from './output.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';

/** Developer: Set Log Level… — Trace, Debug, Info, Warning, Error or Off for the app's logs. */
export async function pickLogLevel() {
	const current = output.logLevel;
	const item = await quick.choose({
		placeholder: t('output.logLevel.pick'),
		items: LOG_LEVELS.map((l) => ({ id: l, label: t(`output.logLevel.${l}`), description: l === current ? t('output.logLevel.current') : undefined })),
		activeId: current
	});
	if (!item) return;
	await output.setLogLevel(item.id as LogLevel).catch((e) => notifications.error(e));
}

const outputShown = () => layout.panelVisible && layout.panelTab === 'output';

/** Output: Show Output Channels… — a quick pick of the channels; the pick is shown in the panel. */
export function showOutputChannels() {
	quick.pick({
		placeholder: t('output.pickChannel'),
		items: output.channels.map((c) => ({ id: c.id, label: c.label })),
		activeId: output.active,
		onAccept: (item) => output.show(item.id)
	});
}

export function installOutputCommands(): () => void {
	const uninstallPolling = output.install();
	const unregister = [
		commands.register({
			id: 'workbench.action.output.toggleOutput',
			title: 'Toggle Output',
			category: 'View',
			key: 'cmd+shift+u',
			run: () => (outputShown() ? (layout.panelVisible = false) : output.show())
		}),
		commands.register({ id: 'workbench.action.showOutputChannels', title: 'Show Output Channels...', category: 'Output', run: showOutputChannels }),
		commands.register({ id: 'workbench.output.action.clearOutput', title: 'Clear Output', category: 'Output', run: () => output.clear() }),
		commands.register({ id: 'workbench.output.action.toggleAutoScroll', title: 'Toggle Auto Scrolling', category: 'Output', run: () => (output.locked = !output.locked) }),
		commands.register({ id: 'workbench.action.openActiveLogOutputFile', title: 'Open Output in Editor', category: 'Output', run: () => output.openInEditor() }),
		commands.register({ id: 'workbench.action.setLogLevel', title: 'Set Log Level...', category: 'Developer', run: () => pickLogLevel() }),
		commands.register({ id: 'workbench.action.toggleMaximizedPanel', title: 'Toggle Maximized Panel', category: 'View', run: () => panelSize.toggle() })
	];
	return () => {
		unregister.forEach((u) => u());
		uninstallPolling();
	};
}
