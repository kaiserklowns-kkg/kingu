// Breakpoints and the stopped line in a Monaco editor (VS Code: breakpointEditorContribution,
// callStackEditorContribution). A glyph margin click toggles a breakpoint; breakpoint decorations
// follow edits, and their new lines are written back to the breakpoint store.

import type * as Monaco from 'monaco-editor';
import { glyphs } from './breakpoints.ts';
import { debug } from './debug.svelte.ts';

type MonacoApi = typeof Monaco;

export type DebugDecorations = { render: () => void; dispose: () => void };

export function attachDebugEditor(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor, path: () => string | null): DebugDecorations {
	editor.updateOptions({ glyphMargin: true });
	const breakpoints = editor.createDecorationsCollection();
	const frame = editor.createDecorationsCollection();
	const sticky = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

	const mouse = editor.onMouseDown((e) => {
		if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton) return;
		const p = path();
		const line = e.target.position?.lineNumber;
		if (p && line) debug.toggleBreakpoint(p, line);
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
			return;
		}
		breakpoints.set(
			glyphs(debug.breakpoints[p], debug.verifiedFor(p)).map((g) => ({
				range: new monaco.Range(g.line, 1, g.line, 1),
				options: { glyphMarginClassName: `kg-bp kg-bp-${g.kind}`, glyphMarginHoverMessage: { value: g.hover }, stickiness: sticky }
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
		} else frame.clear();
	}

	return {
		render,
		dispose: () => {
			mouse.dispose();
			edits.dispose();
			breakpoints.clear();
			frame.clear();
		}
	};
}
