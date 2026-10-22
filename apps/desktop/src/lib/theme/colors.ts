// Workbench chrome colors from a VS Code color theme, as `--vscode-*` CSS variables.
// Pure (no DOM), so `bun test` can exercise it. A theme's `colors` win; anything it leaves out
// falls back to VS Code's color-registry default for the theme type (registerColor in
// microsoft/vscode src/vs/platform/theme/common/colors/*.ts and src/vs/workbench/common/theme.ts).

import { normalizeColor, type ThemeType } from '../editor/textmate/theme';

export type { ThemeType };

/** A literal `#hex`, a reference to another color id, `transparent(x, factor)`, or no color. */
type Value = string | null | readonly ['transparent', Value, number];
type Defaults = Value | readonly [dark: Value, light: Value, hcDark: Value, hcLight: Value];

const t = (v: Value, factor: number) => ['transparent', v, factor] as const;
const TYPES: ThemeType[] = ['dark', 'light', 'hcDark', 'hcLight'];

/**
 * The colors Kingu's chrome uses. Dark values not given by the dark themes are the ones
 * theme.css shipped with (VS Code's dark defaults); light/hc come from the registry.
 */
export const COLOR_DEFAULTS: Record<string, Defaults> = {
	contrastBorder: [null, null, '#6FC3DF', '#0F4A85'],
	contrastActiveBorder: [null, null, 'focusBorder', 'focusBorder'],
	foreground: ['#CCCCCC', '#616161', '#FFFFFF', '#292929'],
	descriptionForeground: [t('foreground', 0.7), '#717171', t('foreground', 0.7), t('foreground', 0.7)],
	focusBorder: ['#007FD4', '#0090F1', '#F38518', '#006BBD'],
	'icon.foreground': ['#C5C5C5', '#424242', '#FFFFFF', '#292929'],
	'widget.border': [null, null, 'contrastBorder', 'contrastBorder'],
	'widget.shadow': [t('#000000', 0.36), t('#000000', 0.16), null, null],
	'keybindingLabel.background': [t('#808080', 0.17), t('#DDDDDD', 0.4), '#00000000', '#00000000'],
	'keybindingLabel.foreground': ['#CCCCCC', '#555555', '#FFFFFF', 'foreground'],
	'keybindingLabel.border': [t('#333333', 0.6), t('#CCCCCC', 0.4), '#6FC3DF', 'contrastBorder'],
	'keybindingLabel.bottomBorder': [t('#444444', 0.6), t('#BBBBBB', 0.4), '#6FC3DF', 'foreground'],
	'selection.background': null,
	errorForeground: ['#F48771', '#A1260D', '#F48771', '#B5200D'],
	'textLink.foreground': ['#3794FF', '#006AB1', '#21A6FF', '#0F4A85'],
	'textPreformat.foreground': ['#D7BA7D', '#A31515', '#FFFFFF', '#FFFFFF'],
	'toolbar.hoverBackground': ['#5A5D5E50', '#B8B8B850', null, null],
	'scrollbarSlider.background': [t('#797979', 0.4), t('#646464', 0.4), t('contrastBorder', 0.6), t('contrastBorder', 0.4)],
	'scrollbarSlider.hoverBackground': [t('#646464', 0.7), t('#646464', 0.7), t('contrastBorder', 0.8), t('contrastBorder', 0.8)],
	// Context menus and dropdown menus (VS Code menuBackground … menuSeparatorBackground defaults).
	'menu.background': ['dropdown.background', 'dropdown.background', 'dropdown.background', 'dropdown.background'],
	'menu.foreground': ['dropdown.foreground', 'dropdown.foreground', 'dropdown.foreground', 'dropdown.foreground'],
	'menu.border': [null, null, 'contrastBorder', 'contrastBorder'],
	'menu.selectionBackground': ['list.activeSelectionBackground', 'list.activeSelectionBackground', 'list.activeSelectionBackground', 'list.activeSelectionBackground'],
	'menu.selectionForeground': ['list.activeSelectionForeground', 'list.activeSelectionForeground', 'list.activeSelectionForeground', 'list.activeSelectionForeground'],
	'menu.separatorBackground': ['#606060', '#D4D4D4', 'contrastBorder', 'contrastBorder'],

	'titleBar.activeBackground': ['#3C3C3C', '#DDDDDD', '#000000', '#FFFFFF'],
	'titleBar.activeForeground': ['#CCCCCC', '#333333', '#FFFFFF', '#292929'],
	'titleBar.border': [null, null, 'contrastBorder', 'contrastBorder'],
	'commandCenter.background': [t('#FFFFFF', 0.05), t('#000000', 0.05), null, null],
	'commandCenter.border': [t('titleBar.activeForeground', 0.2), t('titleBar.activeForeground', 0.2), 'contrastBorder', 'contrastBorder'],
	'titleBar.inactiveBackground': [t('titleBar.activeBackground', 0.6), t('titleBar.activeBackground', 0.6), null, null],
	'titleBar.inactiveForeground': [t('titleBar.activeForeground', 0.6), t('titleBar.activeForeground', 0.6), null, '#292929'],
	'commandCenter.foreground': 'titleBar.activeForeground',
	'commandCenter.activeForeground': 'titleBar.activeForeground',
	'commandCenter.inactiveForeground': 'titleBar.inactiveForeground',
	'commandCenter.activeBackground': [t('#FFFFFF', 0.08), t('#000000', 0.08), null, null],
	'commandCenter.activeBorder': [t('titleBar.activeForeground', 0.3), t('titleBar.activeForeground', 0.3), 'focusBorder', 'focusBorder'],
	'commandCenter.inactiveBorder': [t('titleBar.inactiveForeground', 0.25), t('titleBar.inactiveForeground', 0.25), 'titleBar.inactiveForeground', 'titleBar.inactiveForeground'],
	// Kingu's Agents layout (VS Code's Agents window): the side bar's color, the editor's in high contrast.
	agentsBackground: ['sideBar.background', 'sideBar.background', 'editor.background', 'editor.background'],

	'activityBar.background': ['#333333', '#2C2C2C', '#000000', '#FFFFFF'],
	'activityBar.foreground': ['#FFFFFF', '#FFFFFF', '#FFFFFF', 'editor.foreground'],
	'activityBar.inactiveForeground': [t('activityBar.foreground', 0.4), t('activityBar.foreground', 0.4), '#FFFFFF', 'editor.foreground'],
	'activityBar.activeBorder': ['activityBar.foreground', 'activityBar.foreground', 'contrastBorder', 'contrastBorder'],
	'activityBar.border': [null, null, 'contrastBorder', 'contrastBorder'],
	'activityBarBadge.background': ['#007ACC', '#007ACC', '#000000', '#0F4A85'],
	'activityBarBadge.foreground': '#FFFFFF',

	'sideBar.background': ['#252526', '#F3F3F3', '#000000', '#FFFFFF'],
	'sideBar.foreground': null,
	'sideBar.border': [null, null, 'contrastBorder', 'contrastBorder'],
	'sideBarTitle.foreground': 'sideBar.foreground',
	'sideBarSectionHeader.background': [t('#808080', 0.2), t('#808080', 0.2), null, null],
	'sideBarSectionHeader.border': 'contrastBorder',

	'editor.background': ['#1E1E1E', '#FFFFFF', '#000000', '#FFFFFF'],
	'editor.foreground': ['#BBBBBB', '#333333', '#FFFFFF', 'foreground'],
	'editor.findMatchHighlightBackground': ['#EA5C0055', '#EA5C0055', null, null],
	'editorGroup.border': ['#444444', '#E7E7E7', 'contrastBorder', 'contrastBorder'],
	'editorGroupHeader.tabsBackground': ['#252526', '#F3F3F3', null, null],
	'editorGroupHeader.tabsBorder': null,
	'editorWidget.background': ['#252526', '#F3F3F3', '#0C141F', '#FFFFFF'],
	'editorWidget.foreground': 'foreground',
	'editorWarning.foreground': ['#CCA700', '#BF8803', '#FFD370', '#895503'],
	'editorError.foreground': ['#F14C4C', '#E51400', '#F48771', '#B5200D'],
	'editorInfo.foreground': ['#59A4F9', '#0063D3', '#59A4F9', '#0063D3'],
	'breadcrumb.foreground': t('foreground', 0.8),

	'tab.activeBackground': 'editor.background',
	'tab.activeForeground': ['#FFFFFF', '#333333', '#FFFFFF', '#292929'],
	'tab.activeBorderTop': [null, null, null, '#B5200D'],
	'tab.inactiveBackground': ['#2D2D2D', '#ECECEC', null, null],
	'tab.inactiveForeground': [t('tab.activeForeground', 0.5), t('tab.activeForeground', 0.7), '#FFFFFF', '#292929'],
	'tab.border': ['#252526', '#F3F3F3', 'contrastBorder', 'contrastBorder'],
	'tab.hoverBackground': null,

	'panel.background': 'editor.background',
	'panel.border': [t('#808080', 0.35), t('#808080', 0.35), 'contrastBorder', 'contrastBorder'],
	'panelTitle.activeBorder': ['panelTitle.activeForeground', 'panelTitle.activeForeground', 'contrastBorder', '#B5200D'],
	'panelTitle.activeForeground': ['#E7E7E7', '#424242', '#FFFFFF', 'editor.foreground'],
	'panelTitle.inactiveForeground': [t('panelTitle.activeForeground', 0.6), t('panelTitle.activeForeground', 0.75), '#FFFFFF', 'editor.foreground'],

	'statusBar.background': ['#007ACC', '#007ACC', null, null],
	'statusBar.foreground': ['#FFFFFF', '#FFFFFF', '#FFFFFF', 'editor.foreground'],
	'statusBar.border': [null, null, 'contrastBorder', 'contrastBorder'],
	'statusBarItem.remoteBackground': 'activityBarBadge.background',
	'statusBarItem.remoteForeground': 'activityBarBadge.foreground',

	'input.background': ['#3C3C3C', '#FFFFFF', '#000000', '#FFFFFF'],
	'input.border': [null, null, 'contrastBorder', 'contrastBorder'],
	'input.foreground': 'foreground',
	'input.placeholderForeground': [t('foreground', 0.5), t('foreground', 0.5), t('foreground', 0.7), t('foreground', 0.7)],
	'inputOption.activeBackground': [t('focusBorder', 0.4), t('focusBorder', 0.2), '#00000000', '#00000000'],
	'inputOption.activeBorder': ['#007ACC', '#007ACC', 'contrastBorder', 'contrastBorder'],
	'inputOption.activeForeground': ['#FFFFFF', '#000000', 'foreground', 'foreground'],
	'inputOption.hoverBackground': ['#5A5D5E80', '#B8B8B850', null, null],
	'dropdown.background': ['#3C3C3C', '#FFFFFF', '#000000', '#FFFFFF'],
	'dropdown.foreground': ['#F0F0F0', 'foreground', '#FFFFFF', 'foreground'],
	'dropdown.border': ['dropdown.background', '#CECECE', 'contrastBorder', 'contrastBorder'],
	'checkbox.background': 'dropdown.background',
	'checkbox.foreground': 'dropdown.foreground',
	'checkbox.border': 'dropdown.border',
	'button.background': ['#0E639C', '#007ACC', '#000000', '#0F4A85'],
	'button.foreground': '#FFFFFF',
	'button.border': 'contrastBorder',
	'button.secondaryBackground': ['list.hoverBackground', 'list.hoverBackground', null, '#FFFFFF'],
	'button.secondaryForeground': ['foreground', 'foreground', '#FFFFFF', 'foreground'],
	'badge.background': ['#4D4D4D', '#C4C4C4', '#000000', '#0F4A85'],
	'badge.foreground': ['#FFFFFF', '#333333', '#FFFFFF', '#FFFFFF'],

	'quickInput.background': 'editorWidget.background',
	'quickInput.foreground': 'editorWidget.foreground',
	'quickInputList.focusBackground': 'list.activeSelectionBackground',
	'list.hoverBackground': ['#2A2D2E', '#F0F0F0', t('#FFFFFF', 0.1), t('#0F4A85', 0.1)],
	'list.activeSelectionBackground': ['#04395E', '#0060C0', null, t('#0F4A85', 0.1)],
	'list.activeSelectionForeground': ['#FFFFFF', '#FFFFFF', null, null],
	'list.inactiveSelectionBackground': ['#37373D', '#E4E6F1', null, t('#0F4A85', 0.1)],
	'list.highlightForeground': ['#2AAAFF', '#0066BF', 'focusBorder', 'focusBorder'],
	'sash.hoverBorder': 'focusBorder',
	'sideBarTitle.background': 'sideBar.background',
	// kingu-old's modern tabs (the view switcher's active tile; theme.ts MODERN_TAB_*).
	'modernTab.activeBackground': 'list.inactiveSelectionBackground',
	'modernTab.activeForeground': 'list.inactiveSelectionForeground',
	'modernTab.hoverBackground': 'list.hoverBackground',
	'modernTab.hoverForeground': 'list.hoverForeground',
	'peekView.border': ['#3794FF', '#1A85FF', 'contrastBorder', 'contrastBorder'],

	// The chat view (VS Code's chatColors.ts and interactive.contribution.ts).
	'chat.requestBorder': ['#FFFFFF1A', '#0000001A', 'contrastBorder', 'contrastBorder'],
	'chat.requestBackground': [t('editor.background', 0.62), t('editor.background', 0.62), 'editorWidget.background', null],
	'chat.statusBackground': [t('foreground', 0.08), t('foreground', 0.08), '#000000', '#FFFFFF'],
	'chat.slashCommandBackground': ['#26477866', '#ADCEFF7A', '#FFFFFF', 'badge.background'],
	'chat.slashCommandForeground': ['#85B6FF', '#26569E', '#000000', 'badge.foreground'],
	'chat.avatarBackground': ['#1F1F1F', '#F2F2F2', '#000000', '#FFFFFF'],
	'chat.avatarForeground': 'foreground',
	'chat.editedFileForeground': ['#E2C08D', '#895503', '#E2C08D', '#895503'],
	'chat.requestCodeBorder': ['#004972B8', '#0E639C40', null, null],
	'chat.requestBubbleBackground': [t('editor.selectionBackground', 0.3), t('editor.selectionBackground', 0.3), null, null],
	'chat.requestBubbleHoverBackground': [t('editor.selectionBackground', 0.6), t('editor.selectionBackground', 0.6), null, null],
	'chat.checkpointSeparator': ['#585858', '#A9A9A9', '#A9A9A9', '#A5A5A5'],
	'chat.linesAddedForeground': ['#54B054', '#107C10', '#54B054', '#107C10'],
	'chat.linesRemovedForeground': ['#FC6A6A', '#BC2F32', '#F48771', '#B5200D'],
	'chat.findMatchHighlightBackground': ['editor.findMatchHighlightBackground', 'editor.findMatchHighlightBackground', '#EA5C0055', '#EA5C0055'],
	'chat.findMatchBackground': [t('chat.findMatchHighlightBackground', 2), t('chat.findMatchHighlightBackground', 2), '#EA5C00AA', '#EA5C00AA'],
	'charts.yellow': 'editorWarning.foreground',
	'charts.green': ['#89D185', '#388A34', '#89D185', '#374E06'],
	'chat.sessionStateIndicator.inProgressBorder': ['charts.yellow', 'charts.yellow', 'contrastActiveBorder', 'contrastActiveBorder'],
	'chat.sessionStateIndicator.unvisitedBorder': ['charts.green', 'charts.green', 'contrastActiveBorder', 'contrastActiveBorder'],
	'chat.sessionStateIndicator.needsInputBorder': ['errorForeground', 'errorForeground', 'contrastActiveBorder', 'contrastActiveBorder'],
	'chat.thinkingShimmer': ['#FFFFFF', '#000000', '#FFFFFF', '#000000'],
	'chat.inputWorkingBorderColor1': ['button.background', 'button.background', '#FFFFFF', '#000000'],
	'chat.voiceGlowBaseColor': 'focusBorder',
	'chat.dictationActiveMicGlow': 'chat.voiceGlowBaseColor',
	'interactive.activeCodeBorder': ['peekView.border', 'peekView.border', 'contrastBorder', 'contrastBorder'],
	'interactive.inactiveCodeBorder': ['list.inactiveSelectionBackground', 'list.inactiveSelectionBackground', 'panel.border', 'panel.border'],

	'settings.headerForeground': ['#E7E7E7', '#444444', '#FFFFFF', '#292929'],
	'settings.modifiedItemIndicator': ['#0C7D9D', '#66AFE0', '#00497A', '#66AFE0'],

	// Kingu: the terminal sits in the panel (VS Code's terminal.background default is the panel's).
	'terminal.background': 'panel.background',
	'terminal.foreground': ['#CCCCCC', '#333333', '#FFFFFF', '#292929'],
	'terminal.selectionBackground': 'editor.selectionBackground',
	'editor.selectionBackground': ['#264F78', '#ADD6FF', '#F3F518', '#0F4A85'],
	'terminalCursor.foreground': null
};

/** VS Code's terminal ANSI defaults (terminalColorRegistry.ts ansiColorMap), index order. */
export const ANSI_DEFAULTS: Record<string, readonly [string, string, string, string]> = {
	'terminal.ansiBlack': ['#000000', '#000000', '#000000', '#292929'],
	'terminal.ansiRed': ['#CD3131', '#CD3131', '#CD0000', '#CD3131'],
	'terminal.ansiGreen': ['#0DBC79', '#107C10', '#00CD00', '#136C13'],
	'terminal.ansiYellow': ['#E5E510', '#949800', '#CDCD00', '#949800'],
	'terminal.ansiBlue': ['#2472C8', '#0451A5', '#0000EE', '#0451A5'],
	'terminal.ansiMagenta': ['#BC3FBC', '#BC05BC', '#CD00CD', '#BC05BC'],
	'terminal.ansiCyan': ['#11A8CD', '#0598BC', '#00CDCD', '#0598BC'],
	'terminal.ansiWhite': ['#E5E5E5', '#555555', '#E5E5E5', '#555555'],
	'terminal.ansiBrightBlack': ['#666666', '#666666', '#7F7F7F', '#666666'],
	'terminal.ansiBrightRed': ['#F14C4C', '#F14C4C', '#FF0000', '#CD3131'],
	'terminal.ansiBrightGreen': ['#23D18B', '#14CE14', '#00FF00', '#00BC00'],
	'terminal.ansiBrightYellow': ['#F5F543', '#B5BA00', '#FFFF00', '#B5BA00'],
	'terminal.ansiBrightBlue': ['#3B8EEA', '#3B8EEA', '#5C5CFF', '#0451A5'],
	'terminal.ansiBrightMagenta': ['#D670D6', '#D670D6', '#FF00FF', '#BC05BC'],
	'terminal.ansiBrightCyan': ['#29B8DB', '#29B8DB', '#00FFFF', '#0598BC'],
	'terminal.ansiBrightWhite': ['#E5E5E5', '#A5A5A5', '#FFFFFF', '#A5A5A5']
};

function defaultFor(id: string, type: ThemeType): Value | undefined {
	const ansi = ANSI_DEFAULTS[id];
	if (ansi) return ansi[TYPES.indexOf(type)];
	if (!(id in COLOR_DEFAULTS)) return undefined;
	const d = COLOR_DEFAULTS[id];
	return Array.isArray(d) && d.length === 4 ? (d as readonly Value[])[TYPES.indexOf(type)] : (d as Value);
}

function withAlpha(hex: string, factor: number): string {
	const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
	// VS Code's RGBA clamps the alpha (transparent(x, 2) of a half-transparent color is opaque).
	const a = Math.min(255, Math.round(alpha * factor * 255));
	return hex.slice(0, 7) + a.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Resolves one color id like VS Code's ColorThemeData.getColor: the theme's value, else the
 * registry default for `type` (references resolve through the theme too). `null` means no color.
 */
export function resolveColor(id: string, colors: Record<string, string>, type: ThemeType, seen = new Set<string>()): string | null {
	const own = normalizeColor(colors[id]);
	if (own) return own;
	if (seen.has(id)) return null;
	seen.add(id);
	const evaluate = (v: Value | undefined): string | null => {
		if (v === null || v === undefined) return null;
		if (typeof v === 'string') return v.startsWith('#') ? (normalizeColor(v) ?? null) : resolveColor(v, colors, type, seen);
		const base = evaluate(v[1]);
		return base ? withAlpha(base, v[2]) : null;
	};
	return evaluate(defaultFor(id, type));
}

/** `editor.background` → `--vscode-editor-background`, as VS Code names its CSS variables. */
export const cssVariable = (id: string) => '--vscode-' + id.replace(/\./g, '-');

/**
 * All chrome CSS variables for a theme: every color in COLOR_DEFAULTS, then every other color the
 * theme sets itself (VS Code writes a variable for each color it knows; a part ported from it, say
 * `--vscode-agentsChatInput-background`, finds its theme's value). A color with no value becomes
 * `transparent`, except foregrounds, which inherit the base `foreground` (what an unset CSS color
 * does in VS Code).
 */
export function chromeVariables(colors: Record<string, string>, type: ThemeType): Record<string, string> {
	const out: Record<string, string> = {};
	for (const id of Object.keys(COLOR_DEFAULTS)) {
		const value = resolveColor(id, colors, type) ?? (/foreground$/i.test(id) ? resolveColor('foreground', colors, type) : null);
		out[cssVariable(id)] = value ?? 'transparent';
	}
	for (const id of Object.keys(colors)) {
		if (id in COLOR_DEFAULTS || !/^[\w.-]+$/.test(id)) continue;
		const value = normalizeColor(colors[id]);
		if (value) out[cssVariable(id)] = value;
	}
	return out;
}

/** xterm.js ITheme from the theme's terminal colors. */
export function terminalTheme(colors: Record<string, string>, type: ThemeType) {
	const c = (id: string) => resolveColor(id, colors, type) ?? undefined;
	const ansi = (name: string) => c('terminal.ansi' + name);
	return {
		background: c('terminal.background'),
		foreground: c('terminal.foreground'),
		cursor: c('terminalCursor.foreground') ?? c('terminal.foreground'),
		selectionBackground: c('terminal.selectionBackground'),
		black: ansi('Black'),
		red: ansi('Red'),
		green: ansi('Green'),
		yellow: ansi('Yellow'),
		blue: ansi('Blue'),
		magenta: ansi('Magenta'),
		cyan: ansi('Cyan'),
		white: ansi('White'),
		brightBlack: ansi('BrightBlack'),
		brightRed: ansi('BrightRed'),
		brightGreen: ansi('BrightGreen'),
		brightYellow: ansi('BrightYellow'),
		brightBlue: ansi('BrightBlue'),
		brightMagenta: ansi('BrightMagenta'),
		brightCyan: ansi('BrightCyan'),
		brightWhite: ansi('BrightWhite')
	};
}
