// Shared class names for ADE cards and chips (full strings, so Tailwind sees them).
import type { Chip, TaskStatus } from './model';

export const TONE: Record<Chip['tone'], string> = {
	neutral: 'border-(--vscode-widget-border) text-(--vscode-descriptionForeground)',
	info: 'border-(--vscode-editorInfo-foreground) text-(--vscode-editorInfo-foreground)',
	warn: 'border-(--vscode-editorWarning-foreground) text-(--vscode-editorWarning-foreground)',
	ok: 'border-[#73C991] text-[#73C991]',
	error: 'border-(--vscode-errorForeground) text-(--vscode-errorForeground)'
};

export const STATUS_DOT: Record<TaskStatus, string> = {
	running: 'bg-(--vscode-editorInfo-foreground) animate-pulse',
	waiting: 'bg-(--vscode-editorWarning-foreground)',
	review: 'bg-(--vscode-textLink-foreground)',
	failed: 'bg-(--vscode-errorForeground)',
	done: 'bg-[#73C991]'
};

/** The dot of a task waiting on the answer to its question (Orca's agent-question color). */
export const QUESTION_DOT = 'bg-(--vscode-charts-purple,#B180D7)';
export const QUESTION_TEXT = 'text-(--vscode-charts-purple,#B180D7)';
export const statusDot = (v: { status: TaskStatus; runtime?: { question?: boolean } }) => (v.status === 'waiting' && v.runtime?.question ? QUESTION_DOT : STATUS_DOT[v.status]);

export const BUTTON =
	'inline-flex h-6 items-center gap-1 rounded-sm bg-(--vscode-button-background) px-2 text-xs text-(--vscode-button-foreground) hover:opacity-90 disabled:opacity-50';
export const BUTTON_SECONDARY =
	'inline-flex h-6 items-center gap-1 rounded-sm border border-(--vscode-widget-border) px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-50';
export const ICON_BUTTON = 'grid size-6 place-items-center rounded hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
export const INPUT =
	'w-full rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 py-1 text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus:border-(--vscode-focusBorder)';

/** Colors of a change letter, like the Source Control view. */
export const LETTER_COLOR: Record<string, string> = {
	M: 'text-[#E2C08D]',
	T: 'text-[#E2C08D]',
	A: 'text-[#73C991]',
	'?': 'text-[#73C991]',
	R: 'text-[#73C991]',
	C: 'text-[#73C991]',
	D: 'text-[#F48771]'
};
