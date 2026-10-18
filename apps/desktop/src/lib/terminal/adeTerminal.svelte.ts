// Keeps an ADE terminal on the `kingu.terminal.*` settings (Orca's Terminal page): composed theme
// colors, padding, OSC 52 clipboard writes, gutter-trimmed copy, middle-click paste of the last
// selection, focus follows mouse, hidden pointer while typing, the JIS ¥ key and TUI wheel speed.
// The derivations are in adeTerminalOptions.ts.

import { untrack } from 'svelte';
import type { Terminal } from '@xterm/xterm';
import { settings } from '#lib/settings/settings.svelte.ts';
import { terminalOptionsFrom } from '#lib/settings/mappings.ts';
import { theme } from '#lib/theme/theme.svelte.ts';
import { isMac } from '#lib/workbench/keys.ts';
import { adeTerminalSettings, composeTheme, jisYenInput, parseOsc52, stripSelectionGutter, tuiWheelReports } from './adeTerminalOptions.ts';

const get = <T>(id: string) => settings.get<T>(id);
const current = () => adeTerminalSettings(get);

/** The last text selected in any ADE terminal: what a middle click pastes (X11 primary selection). */
let primarySelection = '';

/** The selection as the clipboard should get it (`kingu.terminal.copyTrimsGutter`). */
export function copiedSelection(term: Terminal, ade: boolean): string {
	const text = term.getSelection();
	return ade && untrack(current).copyTrimsGutter ? stripSelectionGutter(text) : text;
}

export type AdeBinding = {
	/** True while replayed output is written back: an old OSC 52 must not overwrite today's clipboard. */
	replaying: boolean;
	dispose(): void;
};

const REPLAYED = Symbol('kingu.replayedWheel');

export function bindAdeTerminal(term: Terminal, host: HTMLElement, root: HTMLElement, refit: () => void): AdeBinding {
	const binding: AdeBinding = { replaying: false, dispose: () => {} };
	const cleanup: (() => void)[] = [];

	// Theme overrides and opacities, and the padding. Runs after bindTerminalSettings' effect (made
	// first) and tracks the same options, so its base theme never wins over the composed one.
	cleanup.push(
		$effect.root(() => {
			$effect(() => {
				terminalOptionsFrom(get);
				const s = current();
				const colors = theme.terminal;
				untrack(() => {
					if (colors.background) term.options.theme = composeTheme(colors, s);
					term.options.allowTransparency = s.backgroundOpacity < 1;
					host.style.padding = `${s.paddingY}px ${s.paddingX}px`;
					refit();
				});
			});
		})
	);

	// OSC 52: writes only (a `?` read is swallowed unanswered), the last of a burst wins.
	let pending: string | null = null;
	const osc = term.parser.registerOscHandler(52, (data) => {
		if (binding.replaying || !untrack(current).allowOsc52Clipboard) return true;
		const parsed = parseOsc52(data);
		if (parsed.kind !== 'write') return true;
		if (pending === null)
			queueMicrotask(() => {
				const text = pending;
				pending = null;
				if (text !== null) void navigator.clipboard?.writeText(text).catch(() => {});
			});
		pending = parsed.text;
		return true;
	});
	cleanup.push(() => osc.dispose());

	// ⌘C / Copy: the trimmed selection replaces xterm's own.
	const onCopy = (e: ClipboardEvent) => {
		if (!term.hasSelection() || !e.clipboardData) return;
		e.clipboardData.setData('text/plain', copiedSelection(term, true));
		e.preventDefault();
		e.stopImmediatePropagation();
	};
	host.addEventListener('copy', onCopy, true);
	cleanup.push(() => host.removeEventListener('copy', onCopy, true));

	// Middle click pastes the last ADE selection (a TUI with mouse reporting gets the click instead).
	const selection = term.onSelectionChange(() => {
		const text = term.getSelection();
		if (text) primarySelection = copiedSelection(term, true);
	});
	cleanup.push(() => selection.dispose());
	const onMiddle = (e: MouseEvent) => {
		if (e.button !== 1 || !untrack(current).middleClickPaste || term.modes.mouseTrackingMode !== 'none') return;
		e.preventDefault();
		e.stopPropagation();
		if (primarySelection) term.paste(primarySelection);
		term.focus();
	};
	host.addEventListener('mousedown', onMiddle, true);
	cleanup.push(() => host.removeEventListener('mousedown', onMiddle, true));

	// Focus follows mouse, between ADE terminals only (never out of an editor or the composer).
	const onEnter = (e: MouseEvent) => {
		if (!untrack(current).focusFollowsMouse || e.buttons !== 0 || !document.hasFocus()) return;
		const active = document.activeElement;
		if (active && !root.contains(active) && active.closest('[data-ade-terminal]')) term.focus();
	};
	root.addEventListener('mouseenter', onEnter);
	cleanup.push(() => root.removeEventListener('mouseenter', onEnter));

	// Hide the pointer while typing, until the mouse moves.
	const key = term.onKey(() => {
		if (untrack(current).mouseHideWhileTyping) root.classList.add('kingu-mouse-hidden');
	});
	const onMove = () => root.classList.remove('kingu-mouse-hidden');
	root.addEventListener('mousemove', onMove);
	cleanup.push(() => (key.dispose(), root.removeEventListener('mousemove', onMove)));

	// The JIS ¥ key types a backslash (macOS).
	term.attachCustomKeyEventHandler((e) => {
		const r = jisYenInput(e, untrack(current).jisYenToBackslash, isMac);
		if (!r) return true;
		if (r.type === 'input') term.input(r.data, true);
		e.preventDefault();
		return false;
	});

	// A full-screen TUI (mouse reporting on) gets the wheel `tuiScrollSensitivity` times.
	const carry = { value: 0 };
	term.attachCustomWheelEventHandler((e) => {
		if ((e as WheelEvent & { [REPLAYED]?: boolean })[REPLAYED] || term.modes.mouseTrackingMode === 'none') return true;
		const n = tuiWheelReports(untrack(current).tuiScrollSensitivity, carry);
		const target = e.target;
		for (let i = 1; i < n && target; i++) {
			const copy = new WheelEvent(e.type, e) as WheelEvent & { [REPLAYED]?: boolean };
			copy[REPLAYED] = true;
			queueMicrotask(() => target.dispatchEvent(copy));
		}
		return n > 0;
	});

	binding.dispose = () => cleanup.forEach((f) => f());
	return binding;
}
