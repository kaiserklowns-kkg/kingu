// Breakpoints and the stopped line in a Monaco editor (VS Code: breakpointEditorContribution,
// callStackEditorContribution). A glyph margin click toggles a breakpoint; breakpoint decorations
// follow edits, and their new lines are written back to the breakpoint store.

import type * as Monaco from 'monaco-editor';
import { settings } from '#lib/settings/settings.svelte.ts';
import { glyphs } from './breakpoints.ts';
import { debug } from './debug.svelte.ts';
import { inlineValues, localsScope } from './debugSettings.ts';

type MonacoApi = typeof Monaco;

export type DebugDecorations = { render: () => void; dispose: () => void };

export function attachDebugEditor(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor, path: () => string | null): DebugDecorations {
	editor.updateOptions({ glyphMargin: true });
	const breakpoints = editor.createDecorationsCollection();
	const frame = editor.createDecorationsCollection();
	const sticky = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

	const inline = editor.createDecorationsCollection();

	// A glyph margin click toggles a breakpoint; a middle click does `debug.gutterMiddleClickAction`.
	const mouse = editor.onMouseDown((e) => {
		if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
		const p = path();
		const line = e.target.position?.lineNumber;
		if (!p || !line) return;
		if (e.event.leftButton) debug.toggleBreakpoint(p, line, editor.getModel()?.getLanguageId() ?? '');
		else if (e.event.middleButton) {
			const action = settings.get<string>('debug.gutterMiddleClickAction');
			if (action === 'logpoint') void debug.editLogMessage(p, line);
			else if (action === 'conditionalBreakpoint') void debug.editCondition(p, line);
			else if (action === 'triggeredBreakpoint') void debug.editTrigger(p, line);
		}
	});

	const edits = editor.onDidChangeModelContent((e) => {
		const p = path();
		const model = editor.getModel();
		if (!p || !model || !breakpoints.length) return;
		// A reload from disk replaces the whole text: every decoration collapses to line 1.
		const whole = e.changes.length === 1 && e.changes[0].range.startLineNumber === 1 && e.changes[0].range.startColumn === 1 && model.getValueLength() === e.changes[0].text.length;
		if (e.isFlush || whole) return;
		debug.moveBreakpoints(p, breakpoints.getRanges().map((r) => r.startLineNumber));
	});

	function render() {
		const p = path();
		if (!p) {
			breakpoints.clear();
			frame.clear();
			inline.clear();
			return;
		}
		// debug.showBreakpointsInOverviewRuler
		const ruler = settings.get<boolean>('debug.showBreakpointsInOverviewRuler')
			? { color: 'rgb(124, 40, 49)', darkColor: 'rgb(124, 40, 49)', position: monaco.editor.OverviewRulerLane.Left }
			: undefined;
		breakpoints.set(
			glyphs(debug.breakpoints[p], debug.verifiedFor(p), debug.triggered).map((g) => ({
				range: new monaco.Range(g.line, 1, g.line, 1),
				options: { glyphMarginClassName: `kg-bp kg-bp-${g.kind}`, glyphMarginHoverMessage: { value: g.hover }, stickiness: sticky, ...(ruler && { overviewRuler: ruler }) }
			}))
		);
		const loc = debug.stoppedLocation;
		const top = debug.model?.frames[0]?.id === debug.model?.frameId;
		if (loc && loc.rel === p) {
			frame.set([
				{
					range: new monaco.Range(loc.line, 1, loc.line, 1),
					options: { isWholeLine: true, className: top ? 'kg-debug-line' : 'kg-debug-line kg-debug-line-focused', glyphMarginClassName: top ? 'kg-debug-arrow' : 'kg-debug-arrow kg-debug-arrow-focused', stickiness: sticky }
				}
			]);
			renderInline(loc.line);
		} else {
			frame.clear();
			inline.clear();
		}
	}

	/**
	 * debug.inlineValues: `on` shows the local variables' values after the lines of the stopped
	 * function that use them (VS Code's fallback without an inline values provider; Kingu's
	 * language servers have none, so `auto` shows nothing, like VS Code without a provider).
	 */
	function renderInline(stopLine: number) {
		const model = editor.getModel();
		const scope = debug.model && localsScope(debug.model.scopes);
		const vars = scope ? debug.model?.variables[scope.variablesReference] : undefined;
		if (settings.get<string>('debug.inlineValues') !== 'on' || !model || !scope) return inline.clear();
		if (!vars) {
			void debug.expand(scope.variablesReference);
			return inline.clear();
		}
		// The 100 lines up to the stop: DAP frames carry no function range.
		const first = Math.max(1, stopLine - 100);
		const lines = Array.from({ length: stopLine - first + 1 }, (_, i) => model.getLineContent(first + i));
		inline.set(
			inlineValues(lines, first, vars).map((v) => ({
				range: new monaco.Range(v.line, model.getLineMaxColumn(v.line), v.line, model.getLineMaxColumn(v.line)),
				options: { after: { content: v.text, inlineClassName: 'kg-debug-inline-value' }, showIfCollapsed: true }
			}))
		);
	}

	return {
		render,
		dispose: () => {
			mouse.dispose();
			edits.dispose();
			breakpoints.clear();
			frame.clear();
			inline.clear();
		}
	};
}
