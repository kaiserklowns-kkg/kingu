// Orca's hand-built settings panes (General, …) as data: sub-sections of rows in Orca's order
// and words, each row bound to the Kingu setting that does the same thing (ade/orcaMap.ts).
// OrcaPane.svelte draws them in Orca's grammar: label and description left, the control right,
// a separator between sub-sections. A row whose Orca setting Kingu lacks is left out; a
// sub-section that needs more than settings (the CLI switch) names a component.

import type { IconName } from '../workbench/Icon.svelte';
import type { MessageKey } from '../i18n/index';
import type { en } from '../i18n/en';
import type { ParamsOf } from '../i18n/format';

/** A text without parameters, so a row can say it with t(key). */
export type PlainKey = { [K in MessageKey]: [ParamsOf<(typeof en)[K]>] extends [never] ? K : never }[MessageKey];

type Base = {
	/** The Kingu setting. */
	id: string;
	label: PlainKey;
	hint?: PlainKey;
	/** Shown only while this holds (Auto Save Delay only with auto save on). */
	when?: (get: (id: string) => unknown) => boolean;
};
/** `label`: a message key, or a name said as it is (a sound, an agent CLI). */
export type Choice = { value: unknown; label: PlainKey | (string & {}) };
export type PaneRow =
	/** A switch; `on` / `off` are the values it writes when the setting is not a boolean (files.autoSave). */
	| (Base & { kind: 'switch'; on?: unknown; off?: unknown })
	| (Base & { kind: 'segmented' | 'select'; choices: readonly Choice[] })
	| (Base & { kind: 'number'; unit?: string; min?: number; max?: number; step?: number })
	| (Base & { kind: 'text'; placeholder?: string })
	/** Multi-line text under the label (scripts). */
	| (Base & { kind: 'textarea'; placeholder?: string })
	| (Base & { kind: 'list' });

/**
 * `component`: a sub-section drawn by its own component (OrcaPane.svelte PANE_COMPONENTS), before
 * its rows if it has any;
 * `rest`: Kingu settings groups whose other settings follow as rows, so a setting Orca has no
 * row for stays on the pane it belongs to.
 */
export type PaneSection = { title?: PlainKey; hint?: PlainKey; icon?: IconName; rows?: readonly PaneRow[]; component?: 'cli' | 'support' | 'themes'; rest?: readonly string[] };
/** `cards`: each sub-section is its own collapsible card with an icon tile (Orca's Appearance). */
export type OrcaPaneSpec = { id: string; icon: IconName; title: PlainKey; description: PlainKey; layout?: 'cards'; sections: readonly PaneSection[] };

/** Whether a switch row is on: `on` matched, else anything but `off` (confirmOnKill "editor" counts as asking). */
export function switchOn(row: Extract<PaneRow, { kind: 'switch' }>, value: unknown): boolean {
	if (row.on === undefined) return value === true;
	return value === row.on || (row.off !== undefined && value !== row.off);
}

/** Whether a search finds the pane: its title, description, sub-section titles or row words. */
export function paneMatches(spec: OrcaPaneSpec, query: string, say: (key: PlainKey) => string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const keys: (PlainKey | undefined)[] = [spec.title, spec.description, ...spec.sections.flatMap((s) => [s.title, s.hint, ...(s.rows ?? []).flatMap((r) => [r.label, r.hint])])];
	return keys.some((k) => k && say(k).toLowerCase().includes(q));
}

/** Every setting a pane edits (for search and so other panes need not list them twice). */
export const paneSettingIds = (spec: OrcaPaneSpec) => spec.sections.flatMap((s) => (s.rows ?? []).map((r) => r.id));

export const GENERAL: OrcaPaneSpec = {
	id: 'general',
	icon: 'sliders',
	title: 'panes.general.title',
	description: 'panes.general.description',
	sections: [
		{
			title: 'panes.general.navigation',
			rows: [
				{
					kind: 'select',
					id: 'kingu.tabs.ctrlTabOrder',
					label: 'panes.general.tabOrder',
					hint: 'panes.general.tabOrderHint',
					choices: [
						{ value: 'mru', label: 'panes.general.mostRecent' },
						{ value: 'sequential', label: 'panes.general.tabStrip' }
					]
				},
				{ kind: 'switch', id: 'workbench.editor.enablePreview', label: 'panes.general.previewTab', hint: 'panes.general.previewTabHint' },
				{ kind: 'switch', id: 'terminal.integrated.confirmOnKill', label: 'panes.general.confirmTerminalClose', hint: 'panes.general.confirmTerminalCloseHint', on: 'always', off: 'never' }
			]
		},
		{
			title: 'panes.general.workspace',
			hint: 'panes.general.workspaceHint',
			rows: [
				{
					kind: 'segmented',
					id: 'kingu.worktree.externalVisibility',
					label: 'panes.general.externalWorktrees',
					hint: 'panes.general.externalWorktreesHint',
					choices: [
						{ value: 'hide', label: 'panes.general.hide' },
						{ value: 'show', label: 'panes.general.show' }
					]
				},
				{ kind: 'switch', id: 'kingu.worktree.confirmRemove', label: 'panes.general.confirmDeleteWorkspace', hint: 'panes.general.confirmDeleteWorkspaceHint' },
				{ kind: 'switch', id: 'kingu.automations.confirmDelete', label: 'panes.general.confirmDeleteAutomation', hint: 'panes.general.confirmDeleteAutomationHint' },
				{ kind: 'list', id: 'kingu.worktree.openIn', label: 'panes.general.openIn', hint: 'panes.general.openInHint' }
			]
		},
		{
			title: 'panes.general.editor',
			hint: 'panes.general.editorHint',
			rows: [
				{ kind: 'switch', id: 'files.autoSave', label: 'panes.general.autoSave', hint: 'panes.general.autoSaveHint', on: 'afterDelay', off: 'off' },
				{
					kind: 'number',
					id: 'files.autoSaveDelay',
					label: 'panes.general.autoSaveDelay',
					hint: 'panes.general.autoSaveDelayHint',
					unit: 'ms',
					min: 250,
					max: 10000,
					when: (get) => get('files.autoSave') === 'afterDelay'
				},
				{
					kind: 'segmented',
					id: 'diffEditor.renderSideBySide',
					label: 'panes.general.diffView',
					hint: 'panes.general.diffViewHint',
					choices: [
						{ value: false, label: 'panes.general.inline' },
						{ value: true, label: 'panes.general.sideBySide' }
					]
				},
				{
					kind: 'segmented',
					id: 'diffEditor.wordWrap',
					label: 'panes.general.diffWrap',
					hint: 'panes.general.diffWrapHint',
					choices: [
						{ value: 'off', label: 'panes.general.off' },
						{ value: 'on', label: 'panes.general.on' }
					]
				},
				{ kind: 'switch', id: 'editor.minimap.enabled', label: 'panes.general.minimap', hint: 'panes.general.minimapHint' }
			]
		},
		{ title: 'panes.general.cli', hint: 'panes.general.cliHint', component: 'cli' },
		{ title: 'panes.general.support', component: 'support' }
	]
};

const sw = (id: string, label: PlainKey, hint?: PlainKey, extra: Partial<Extract<PaneRow, { kind: 'switch' }>> = {}): PaneRow => ({ kind: 'switch', id, label, hint, ...extra });

export const GIT: OrcaPaneSpec = {
	id: 'git',
	icon: 'branch',
	title: 'panes.git.title',
	description: 'panes.git.description',
	sections: [
		{
			rows: [
				{ kind: 'text', id: 'kingu.worktree.branchPrefix', label: 'panes.git.branchPrefix', hint: 'panes.git.branchPrefixHint', placeholder: 'feature/' },
				sw('kingu.worktree.refreshBaseOnCreate', 'panes.git.keepMain', 'panes.git.keepMainHint'),
				{
					kind: 'segmented',
					id: 'kingu.git.compareAgainstUpstream',
					label: 'panes.git.compareBase',
					hint: 'panes.git.compareBaseHint',
					choices: [
						{ value: false, label: 'panes.git.repoDefault' },
						{ value: true, label: 'panes.git.upstream' }
					]
				},
				sw('kingu.worktree.autoRenameBranch', 'panes.git.autoRename', 'panes.git.autoRenameHint')
			]
		},
		{
			title: 'panes.git.ai',
			hint: 'panes.git.aiHint',
			rows: [
				sw('kingu.git.ai.enabled', 'panes.git.aiEnabled', 'panes.git.aiEnabledHint'),
				{
					kind: 'select',
					id: 'kingu.git.ai.agent',
					label: 'panes.git.aiAgent',
					hint: 'panes.git.aiAgentHint',
					when: (get) => get('kingu.git.ai.enabled') !== false,
					choices: [
						{ value: '', label: 'panes.git.useDefault' },
						...['claude', 'codex', 'gemini', 'qwen', 'opencode', 'cursor', 'copilot', 'amp'].map((v) => ({ value: v, label: v })),
						{ value: 'custom', label: 'panes.git.custom' }
					]
				},
				{ kind: 'text', id: 'kingu.git.ai.model', label: 'panes.git.aiModel', hint: 'panes.git.aiModelHint', when: (get) => get('kingu.git.ai.enabled') !== false },
				{
					kind: 'text',
					id: 'kingu.git.ai.customCommand',
					label: 'panes.git.customCommand',
					hint: 'panes.git.customCommandHint',
					placeholder: 'ollama run llama3.1 {prompt}',
					when: (get) => get('kingu.git.ai.enabled') !== false && get('kingu.git.ai.agent') === 'custom'
				},
				{ kind: 'text', id: 'kingu.git.ai.commitInstructions', label: 'panes.git.commitInstructions', hint: 'panes.git.commitInstructionsHint', when: (get) => get('kingu.git.ai.enabled') !== false },
				{ kind: 'text', id: 'kingu.git.ai.prInstructions', label: 'panes.git.prInstructions', hint: 'panes.git.prInstructionsHint', when: (get) => get('kingu.git.ai.enabled') !== false },
				{ kind: 'text', id: 'kingu.git.ai.branchNameInstructions', label: 'panes.git.branchInstructions', hint: 'panes.git.branchInstructionsHint', when: (get) => get('kingu.git.ai.enabled') !== false }
			]
		},
		{
			title: 'panes.git.review',
			hint: 'panes.git.reviewHint',
			rows: [
				sw('kingu.pr.draft', 'panes.git.draft', 'panes.git.draftHint'),
				sw('kingu.pr.useTemplate', 'panes.git.template', 'panes.git.templateHint'),
				sw('kingu.pr.generateDetailsOnOpen', 'panes.git.generate', 'panes.git.generateHint'),
				sw('kingu.pr.openAfterCreate', 'panes.git.openAfter', 'panes.git.openAfterHint'),
				{ kind: 'list', id: 'kingu.pr.botAuthors', label: 'panes.git.bots', hint: 'panes.git.botsHint' }
			]
		},
		{ title: 'panes.more', rest: ['Worktrees', 'Repository', 'Source Control AI', 'Pull Requests'] }
	]
};

export const TERMINAL: OrcaPaneSpec = {
	id: 'terminal',
	icon: 'terminal',
	title: 'panes.terminal.title',
	description: 'panes.terminal.description',
	sections: [
		{
			title: 'panes.terminal.shell',
			hint: 'panes.terminal.shellHint',
			rows: [
				{ kind: 'text', id: 'terminal.integrated.shell.osx', label: 'panes.terminal.shellPath', hint: 'panes.terminal.shellPathHint', placeholder: '/bin/zsh' },
				{ kind: 'list', id: 'terminal.integrated.shellArgs.osx', label: 'panes.terminal.shellArgs', hint: 'panes.terminal.shellArgsHint' }
			]
		},
		{
			title: 'panes.terminal.rendering',
			hint: 'panes.terminal.renderingHint',
			rows: [{ kind: 'number', id: 'terminal.integrated.minimumContrastRatio', label: 'panes.terminal.contrast', hint: 'panes.terminal.contrastHint', unit: ':1', min: 1, max: 21, step: 0.1 }]
		},
		{
			title: 'panes.terminal.interaction',
			hint: 'panes.terminal.interactionHint',
			rows: [
				{ kind: 'number', id: 'terminal.integrated.mouseWheelScrollSensitivity', label: 'panes.terminal.scrollNormal', hint: 'panes.terminal.scrollNormalHint', unit: 'x', min: 0.5, max: 3, step: 0.05 },
				{ kind: 'number', id: 'terminal.integrated.fastScrollSensitivity', label: 'panes.terminal.scrollFast', hint: 'panes.terminal.scrollFastHint', unit: 'x', min: 1, max: 10, step: 0.5 },
				{ kind: 'number', id: 'kingu.terminal.tuiScrollSensitivity', label: 'panes.terminal.scrollTui', hint: 'panes.terminal.scrollTuiHint', unit: 'x', min: 1, max: 10, step: 1 },
				sw('terminal.integrated.rightClickBehavior', 'panes.terminal.rightClick', 'panes.terminal.rightClickHint', { on: 'paste', off: 'selectWord' }),
				sw('kingu.terminal.focusFollowsMouse', 'panes.terminal.focusFollows', 'panes.terminal.focusFollowsHint'),
				sw('terminal.integrated.copyOnSelection', 'panes.terminal.copyOnSelect', 'panes.terminal.copyOnSelectHint'),
				sw('kingu.terminal.copyTrimsGutter', 'panes.terminal.trimGutter', 'panes.terminal.trimGutterHint'),
				sw('kingu.terminal.allowOsc52Clipboard', 'panes.terminal.osc52', 'panes.terminal.osc52Hint')
			]
		},
		{
			title: 'panes.terminal.advanced',
			hint: 'panes.terminal.advancedHint',
			rows: [
				{ kind: 'number', id: 'terminal.integrated.scrollback', label: 'panes.terminal.scrollback', hint: 'panes.terminal.scrollbackHint', unit: 'rows', min: 1000, max: 50000, step: 100 },
				{ kind: 'text', id: 'terminal.integrated.wordSeparators', label: 'panes.terminal.wordSeparators', hint: 'panes.terminal.wordSeparatorsHint' },
				sw('kingu.terminal.scopeHistoryByWorktree', 'panes.terminal.history', 'panes.terminal.historyHint'),
				sw('terminal.integrated.macOptionIsMeta', 'panes.terminal.optionAsAlt', 'panes.terminal.optionAsAltHint'),
				sw('kingu.terminal.jisYenToBackslash', 'panes.terminal.jisYen', 'panes.terminal.jisYenHint')
			]
		},
	]
};

export const FLOATING: OrcaPaneSpec = {
	id: 'floating',
	icon: 'floating',
	title: 'panes.floating.title',
	description: 'panes.floating.description',
	sections: [
		{
			rows: [
				sw('kingu.floating.enabled', 'panes.floating.enabled', 'panes.floating.enabledHint'),
				{ kind: 'text', id: 'kingu.floating.cwd', label: 'panes.floating.cwd', hint: 'panes.floating.cwdHint', placeholder: '~' },
				{
					kind: 'segmented',
					id: 'kingu.floating.triggerLocation',
					label: 'panes.floating.trigger',
					hint: 'panes.floating.triggerHint',
					choices: [
						{ value: 'floating-button', label: 'panes.floating.button' },
						{ value: 'status-bar', label: 'panes.floating.statusBar' }
					]
				}
			]
		}
	]
};

export const AUTOMATIONS: OrcaPaneSpec = {
	id: 'automations',
	icon: 'clock',
	title: 'panes.automations.title',
	description: 'panes.automations.description',
	sections: [
		{
			rows: [
				// Orca asks about deleting automations under General › Workspace, not here.
				sw('kingu.sidebar.showAutomations', 'panes.automations.button', 'panes.automations.buttonHint')
			]
		},
		{ title: 'panes.automations.how', hint: 'panes.automations.howHint', rows: [] }
	]
};

export const CHAT: OrcaPaneSpec = {
	id: 'chat',
	icon: 'chat',
	title: 'panes.chat.title',
	description: 'panes.chat.description',
	sections: [
		{
			title: 'panes.chat.appearance',
			rows: [
				sw('kingu.chat.matchTerminalFont', 'panes.chat.matchTerminal', 'panes.chat.matchTerminalHint'),
				{ kind: 'number', id: 'kingu.chat.contrast', label: 'panes.chat.contrast', hint: 'panes.chat.contrastHint', unit: '%', min: 50, max: 150, step: 5 },
				{ kind: 'number', id: 'kingu.chat.fontSize', label: 'panes.chat.textSize', hint: 'panes.chat.textSizeHint', unit: 'px', min: 12, max: 20 },
				{ kind: 'number', id: 'kingu.chat.codeFontSize', label: 'panes.chat.codeSize', hint: 'panes.chat.codeSizeHint', unit: 'px', min: 10, max: 18 },
				{
					kind: 'segmented',
					id: 'kingu.chat.width',
					label: 'panes.chat.width',
					hint: 'panes.chat.widthHint',
					choices: [
						{ value: 'comfortable', label: 'panes.chat.comfortable' },
						{ value: 'wide', label: 'panes.chat.wide' },
						{ value: 'full', label: 'panes.chat.full' }
					]
				}
			]
		},
		{
			title: 'panes.chat.behavior',
			rows: [
				{
					kind: 'select',
					id: 'kingu.agent.permissionMode',
					label: 'panes.chat.permissions',
					hint: 'panes.chat.permissionsHint',
					choices: [
						{ value: 'default', label: 'panes.chat.ask' },
						{ value: 'acceptEdits', label: 'panes.chat.acceptEdits' },
						{ value: 'plan', label: 'panes.chat.plan' }
					]
				},
				sw('kingu.chat.resumeWorkOnRestart', 'panes.chat.resume', 'panes.chat.resumeHint')
			]
		},
		{ title: 'panes.chat.names', rows: [sw('kingu.chat.aiTitles', 'panes.chat.names', 'panes.chat.namesHint')] },
		{ title: 'panes.more', rest: ['Agent Chat'] }
	]
};

export const INPUT: OrcaPaneSpec = {
	id: 'input',
	icon: 'keyboard',
	title: 'panes.input.title',
	description: 'panes.input.description',
	sections: [{ rows: [sw('kingu.terminal.middleClickPaste', 'panes.terminal.middlePaste', 'panes.terminal.middlePasteHint')] }]
};

export const NOTIFICATIONS: OrcaPaneSpec = {
	id: 'notifications',
	icon: 'bell',
	title: 'panes.notifications.title',
	description: 'panes.notifications.description',
	sections: [
		{ rows: [sw('kingu.agent.notifications', 'panes.notifications.enabled', 'panes.notifications.enabledHint')] },
		{
			rows: [
				sw('kingu.agent.notifications.events', 'panes.notifications.taskComplete', 'panes.notifications.taskCompleteHint', { on: 'all', off: 'attention' }),
				sw('kingu.agent.notifications.terminalBell', 'panes.notifications.bell', 'panes.notifications.bellHint'),
				sw('kingu.agent.notifications.hiddenWorkspaces', 'panes.notifications.hidden', 'panes.notifications.hiddenHint')
			]
		},
		{
			rows: [
				{
					kind: 'select',
					id: 'kingu.agent.notifications.sound',
					label: 'panes.notifications.sound',
					hint: 'panes.notifications.soundHint',
					choices: [
						{ value: 'default', label: 'panes.notifications.systemDefault' },
						{ value: 'none', label: 'panes.notifications.none' },
						...['Glass', 'Ping', 'Pop', 'Hero', 'Submarine', 'Tink'].map((v) => ({ value: v, label: v }))
					]
				}
			]
		},
		{ rows: [sw('kingu.agent.notifications.suppressWhenFocused', 'panes.notifications.suppress', 'panes.notifications.suppressHint')] },
		{ title: 'panes.more', rest: ['Notifications'] }
	]
};

export const ADVANCED: OrcaPaneSpec = {
	id: 'advanced',
	icon: 'sliders',
	title: 'panes.advanced.title',
	description: 'panes.advanced.description',
	sections: [
		{
			title: 'panes.advanced.network',
			hint: 'panes.advanced.networkHint',
			rows: [
				{ kind: 'text', id: 'http.proxy', label: 'panes.advanced.proxy', hint: 'panes.advanced.proxyHint', placeholder: 'http://proxy.example.com:8080' },
				{ kind: 'list', id: 'http.noProxy', label: 'panes.advanced.bypass', hint: 'panes.advanced.bypassHint' }
			]
		}
	]
};

export const EXPERIMENTAL: OrcaPaneSpec = {
	id: 'experimental',
	icon: 'sparkle',
	title: 'panes.experimental.title',
	description: 'panes.experimental.description',
	sections: [
		{
			rows: [
				sw('kingu.agent.runMode', 'panes.experimental.chatUi', 'panes.experimental.chatUiHint', { on: 'timeline', off: 'terminal' }),
				sw('kingu.agent.hibernation', 'panes.experimental.sleep', 'panes.experimental.sleepHint'),
				{
					kind: 'number',
					id: 'kingu.agent.hibernationIdleMinutes',
					label: 'panes.experimental.sleepAfter',
					hint: 'panes.experimental.sleepAfterHint',
					unit: 'min',
					min: 1,
					max: 1440,
					when: (get) => get('kingu.agent.hibernation') === true
				}
			]
		}
	]
};

const tinted = (get: (id: string) => unknown) => get('kingu.sidebar.appearance') === 'tinted';

export const APPEARANCE: OrcaPaneSpec = {
	id: 'appearance',
	icon: 'layout',
	title: 'panes.appearance.title',
	description: 'panes.appearance.description',
	layout: 'cards',
	sections: [
		{
			title: 'panes.appearance.interface',
			icon: 'layout',
			component: 'themes',
			rows: [
				{
					kind: 'select',
					id: 'kingu.uiLanguage',
					label: 'panes.appearance.language',
					choices: [
						{ value: 'auto', label: 'panes.appearance.system' },
						{ value: 'th', label: 'ไทย' },
						{ value: 'en', label: 'English' }
					]
				},
				{ kind: 'number', id: 'window.zoomLevel', label: 'panes.appearance.zoom', hint: 'panes.appearance.zoomHint', min: -8, max: 8, step: 0.5 },
				{ kind: 'number', id: 'editor.fontSize', label: 'panes.appearance.editorFontSize', unit: 'px', min: 6, max: 100 },
				{ kind: 'text', id: 'kingu.ui.fontFamily', label: 'panes.appearance.ideFont', hint: 'panes.appearance.ideFontHint', placeholder: 'system-ui' }
			]
		},
		{
			title: 'panes.appearance.terminal',
			icon: 'terminal',
			rows: [
				{ kind: 'number', id: 'terminal.integrated.fontSize', label: 'panes.appearance.fontSize', hint: 'panes.appearance.fontSizeHint', unit: 'px', min: 6, max: 100 },
				{ kind: 'text', id: 'terminal.integrated.fontFamily', label: 'panes.appearance.fontFamily', hint: 'panes.appearance.fontFamilyHint', placeholder: 'Menlo' },
				{ kind: 'number', id: 'terminal.integrated.lineHeight', label: 'panes.appearance.lineHeight', min: 1, max: 3, step: 0.05 },
				{
					kind: 'segmented',
					id: 'terminal.integrated.cursorStyle',
					label: 'panes.appearance.cursorShape',
					choices: [
						{ value: 'line', label: 'panes.appearance.bar' },
						{ value: 'block', label: 'panes.appearance.block' },
						{ value: 'underline', label: 'panes.appearance.underline' }
					]
				},
				sw('terminal.integrated.cursorBlinking', 'panes.appearance.blink'),
				{ kind: 'number', id: 'kingu.terminal.cursorOpacity', label: 'panes.appearance.cursorOpacity', min: 0, max: 1, step: 0.05 },
				{ kind: 'number', id: 'kingu.terminal.inactivePaneOpacity', label: 'panes.appearance.inactiveOpacity', min: 0.1, max: 1, step: 0.05 },
				{ kind: 'number', id: 'kingu.terminal.dividerThicknessPx', label: 'panes.appearance.dividerThickness', unit: 'px', min: 1, max: 12 },
				{ kind: 'text', id: 'kingu.terminal.dividerColorDark', label: 'panes.appearance.dividerDark', placeholder: '#3f3f46' },
				{ kind: 'text', id: 'kingu.terminal.dividerColorLight', label: 'panes.appearance.dividerLight', placeholder: '#d4d4d8' },
				{ kind: 'number', id: 'kingu.terminal.backgroundOpacity', label: 'panes.appearance.backgroundOpacity', min: 0, max: 1, step: 0.05 },
				{ kind: 'number', id: 'kingu.terminal.paddingX', label: 'panes.appearance.paddingX', unit: 'px', min: 0, max: 64 },
				{ kind: 'number', id: 'kingu.terminal.paddingY', label: 'panes.appearance.paddingY', unit: 'px', min: 0, max: 64 },
				sw('kingu.terminal.mouseHideWhileTyping', 'panes.appearance.hideMouse')
			]
		},
		{
			title: 'panes.appearance.window',
			icon: 'sidebarLeft',
			rows: [
				{
					kind: 'segmented',
					id: 'kingu.sidebar.appearance',
					label: 'panes.appearance.sidebar',
					hint: 'panes.appearance.sidebarHint',
					choices: [
						{ value: 'default', label: 'panes.appearance.default' },
						{ value: 'match-terminal', label: 'panes.appearance.matchTerminal' },
						{ value: 'tinted', label: 'panes.appearance.tinted' }
					]
				},
				{ kind: 'text', id: 'kingu.sidebar.tintColor', label: 'panes.appearance.tint', hint: 'panes.appearance.tintHint', placeholder: '#18181b', when: tinted },
				{ kind: 'number', id: 'kingu.sidebar.tintOpacity', label: 'panes.appearance.tintStrength', min: 0, max: 0.35, step: 0.01, when: tinted },
				{
					kind: 'segmented',
					id: 'kingu.statusBar.usage.display',
					label: 'panes.appearance.usage',
					choices: [
						{ value: 'used', label: 'panes.appearance.used' },
						{ value: 'remaining', label: 'panes.appearance.remaining' }
					]
				},
				sw('kingu.statusBar.claudeUsage.visible', 'panes.appearance.claudeUsage'),
				sw('kingu.statusBar.codexUsage.visible', 'panes.appearance.codexUsage'),
				sw('kingu.statusBar.keepAwake.visible', 'panes.appearance.keepAwake'),
				sw('kingu.statusBar.resources.visible', 'panes.appearance.resources'),
				sw('kingu.statusBar.ports.visible', 'panes.appearance.ports'),
				{
					kind: 'segmented',
					id: 'kingu.sidebar.compactCards',
					label: 'panes.appearance.cards',
					choices: [
						{ value: false, label: 'panes.appearance.detailed' },
						{ value: true, label: 'panes.appearance.compact' }
					]
				},
				sw('kingu.sidebar.showIssues', 'panes.appearance.tasksButton'),
				sw('explorer.excludeGitIgnore', 'panes.appearance.gitIgnored', 'panes.appearance.gitIgnoredHint', { on: false, off: true }),
				sw('search.followSymlinks', 'panes.appearance.symlinks')
			]
		},
		{ title: 'panes.more', rest: ['ADE Sidebar', 'ADE Terminal'] }
	]
};

/** The Orca panes by id: the table of contents' `{ pane }` entries (panes.ts ORCA_NAV). */
export const ORCA_PANES: Readonly<Record<string, OrcaPaneSpec>> = {
	general: GENERAL,
	appearance: APPEARANCE,
	git: GIT,
	terminal: TERMINAL,
	floating: FLOATING,
	automations: AUTOMATIONS,
	chat: CHAT,
	input: INPUT,
	notifications: NOTIFICATIONS,
	advanced: ADVANCED,
	experimental: EXPERIMENTAL
};

/** Every setting the Orca panes give a row of their own; other panes leave them out. */
export const PANE_SETTING_IDS: readonly string[] = Object.values(ORCA_PANES).flatMap(paneSettingIds);

/** The groups the Orca panes show the rest of (their "More" sub-sections). */
export const PANE_REST_GROUPS: readonly string[] = Object.values(ORCA_PANES).flatMap((p) => p.sections.flatMap((s) => s.rest ?? []));

/**
 * The open folder's project pane (Orca's per-project settings under Projects), in the
 * repository scope: identity, worktree defaults and hooks, shared paths, Source Control AI.
 */
export const PROJECT: OrcaPaneSpec = {
	id: 'project',
	icon: 'folder',
	title: 'panes.project.title',
	description: 'panes.project.title',
	sections: [
		{
			title: 'panes.project.identity',
			hint: 'panes.project.identityHint',
			rows: [
				{ kind: 'text', id: 'kingu.repo.displayName', label: 'panes.project.displayName' },
				{ kind: 'text', id: 'kingu.repo.icon', label: 'panes.project.icon', hint: 'panes.project.iconHint' },
				{ kind: 'text', id: 'kingu.repo.badgeColor', label: 'panes.project.color', hint: 'panes.project.colorHint', placeholder: '#4f46e5' },
				{ kind: 'text', id: 'kingu.worktree.baseBranch', label: 'panes.project.baseBranch', hint: 'panes.project.baseBranchHint', placeholder: 'main' },
				{
					kind: 'segmented',
					id: 'kingu.worktree.externalVisibility',
					label: 'panes.project.external',
					choices: [
						{ value: 'hide', label: 'panes.general.hide' },
						{ value: 'show', label: 'panes.general.show' }
					]
				}
			]
		},
		{
			title: 'panes.project.hooks',
			hint: 'panes.project.hooksHint',
			rows: [
				{ kind: 'textarea', id: 'kingu.repo.setupScript', label: 'panes.project.setup', hint: 'panes.project.setupHint', placeholder: 'bun install' },
				{
					kind: 'segmented',
					id: 'kingu.worktree.setupScript',
					label: 'panes.project.whenSetup',
					choices: [
						{ value: 'auto', label: 'panes.project.runDefault' },
						{ value: 'ask', label: 'panes.project.askEvery' },
						{ value: 'off', label: 'panes.project.skipDefault' }
					]
				},
				sw('kingu.worktree.setupAgentStartup', 'panes.project.waitSetup', undefined, { on: 'wait-for-setup', off: 'start-immediately' }),
				{ kind: 'textarea', id: 'kingu.repo.archiveScript', label: 'panes.project.archive', hint: 'panes.project.archiveHint' },
				{ kind: 'textarea', id: 'kingu.repo.issueCommand', label: 'panes.project.issueCommand', hint: 'panes.project.issueCommandHint' },
				{
					kind: 'segmented',
					id: 'kingu.repo.scriptSource',
					label: 'panes.project.source',
					hint: 'panes.project.sourceHint',
					choices: [
						{ value: 'auto', label: 'panes.project.auto' },
						{ value: 'shared-only', label: 'panes.project.yamlOnly' },
						{ value: 'local-only', label: 'panes.project.localOnly' },
						{ value: 'run-both', label: 'panes.project.both' }
					]
				}
			]
		},
		{ title: 'panes.project.shared', hint: 'panes.project.sharedHint', rows: [{ kind: 'list', id: 'kingu.repo.symlinkPaths', label: 'panes.project.shared' }] },
		{
			title: 'panes.project.ai',
			hint: 'panes.project.aiHint',
			rows: [
				{ kind: 'textarea', id: 'kingu.git.ai.commitInstructions', label: 'panes.git.commitInstructions', hint: 'panes.git.commitInstructionsHint' },
				{ kind: 'textarea', id: 'kingu.git.ai.prInstructions', label: 'panes.git.prInstructions', hint: 'panes.git.prInstructionsHint' },
				{ kind: 'textarea', id: 'kingu.git.ai.branchNameInstructions', label: 'panes.git.branchInstructions', hint: 'panes.git.branchInstructionsHint' }
			]
		}
	]
};
