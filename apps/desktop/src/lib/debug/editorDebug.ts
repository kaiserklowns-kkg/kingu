// Breakpoints, the stopped line and the debug hover in a Monaco editor (VS Code:
// breakpointEditorContribution, callStackEditorContribution, debugEditorContribution). A glyph
// margin click toggles a breakpoint and a right click opens the breakpoint menu; breakpoint
// decorations follow edits, and their new lines are written back to the breakpoint store. While
// stopped, hovering an expression shows its value and the editor menu offers Run to Cursor and
// Jump to Cursor.

import type * as Monaco from 'monaco-editor';
import { settings } from '#lib/settings/settings.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { menuItem, menuSeparator } from '#lib/workbench/PopupMenu.svelte';
import { popupMenuAt } from '#lib/workbench/popupMenuAt.ts';
import { glyphs } from './breakpoints.ts';
import { debug } from './debug.svelte.ts';
import { inlineValues, localsScope } from './debugSettings.ts';
import { expressionAt } from './hover.ts';

type MonacoApi = typeof Monaco;

export type DebugDecorations = { render: () => void; dispose: () => void };

/** Monaco instances that have the debug hover provider (one per instance, for every language). */
const hoverInstalled = new WeakSet<object>();

/** Markdown for a value in the hover: the expression, its value, and the first children of a structure. */
async function hoverContents(expression: string): Promise<Monaco.IMarkdownString[] | null> {
	const r = await debug.hover(expression);
	if (!r) return null;
	const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, '`​``')}\n\`\`\``;
	const parts = [fence(`${expression}: ${r.result}`)];
	if (r.variablesReference > 0) {
		const children = (await debug.expand(r.variablesReference)).slice(0, 20);
		if (children.length) parts.push(fence(children.map((c) => `${c.name}: ${c.value}`).join('\n')));
	}
	return parts.map((value) => ({ value }));
}

function installHover(monaco: MonacoApi) {
	if (hoverInstalled.has(monaco)) return;
	hoverInstalled.add(monaco);
	monaco.languages.registerHoverProvider('*', {
		async provideHover(model, position) {
			if (!debug.stopped) return null;
			// A selection under the mouse is evaluated as it is (VS Code does the same).
			const editor = monaco.editor.getEditors().find((e) => e.getModel() === model && e.hasTextFocus());
			const sel = editor?.getSelection();
			let expression: string | null = null;
			let range: Monaco.IRange | null = null;
			if (sel && !sel.isEmpty() && sel.containsPosition(position) && sel.startLineNumber === sel.endLineNumber) {
				expression = model.getValueInRange(sel);
				range = sel;
			} else {
				const found = expressionAt(model.getLineContent(position.lineNumber), position.column);
				if (found) {
					expression = found.expression;
					range = new monaco.Range(position.lineNumber, found.start, position.lineNumber, found.end + 1);
				}
			}
			if (!expression?.trim() || !range) return null;
			const contents = await hoverContents(expression.trim());
			return contents ? { range, contents } : null;
		}
	});
}

export function attachDebugEditor(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor, path: () => string | null): DebugDecorations {
	editor.updateOptions({ glyphMargin: true });
	installHover(monaco);
	const breakpoints = editor.createDecorationsCollection();
	const frame = editor.createDecorationsCollection();
	const sticky = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
	// VS Code puts breakpoints and the stack frame arrow in the right glyph lane (tests use the center one).
	const lane = { position: monaco.editor.GlyphMarginLane.Right };

	const inline = editor.createDecorationsCollection();

	// Editor context menu (VS Code's debug group): only while stopped.
	const stoppedKey = editor.createContextKey<boolean>('kgDebugStopped', false);
	const jumpKey = editor.createContextKey<boolean>('kgDebugCanJump', false);
	const lineOf = () => editor.getPosition()?.lineNumber ?? 1;
	const actions = [
		editor.addAction({ id: 'kingu.debug.runToCursor', label: 'Run to Cursor', contextMenuGroupId: 'debug', contextMenuOrder: 1, precondition: 'kgDebugStopped', run: () => void debug.runToCursor(path(), lineOf()) }),
		editor.addAction({ id: 'kingu.debug.jumpToCursor', label: 'Jump to Cursor', contextMenuGroupId: 'debug', contextMenuOrder: 2, precondition: 'kgDebugCanJump', run: () => void debug.jumpToCursor(path(), lineOf()) }),
		editor.addAction({
			id: 'kingu.debug.addToWatch',
			label: 'Add to Watch',
			contextMenuGroupId: 'debug',
			contextMenuOrder: 3,
			precondition: 'kgDebugStopped',
			run: () => {
				const model = editor.getModel();
				const sel = editor.getSelection();
				const pos = editor.getPosition();
				if (!model || !pos) return;
				const text = sel && !sel.isEmpty() ? model.getValueInRange(sel) : expressionAt(model.getLineContent(pos.lineNumber), pos.column)?.expression;
				if (text) debug.addWatch(text);
			}
		})
	];

	// The breakpoint menu (VS Code: breakpointEditorContribution's context menu).
	function gutterMenu(e: Monaco.editor.IEditorMouseEvent, p: string, line: number) {
		const existing = debug.breakpoints[p]?.find((b) => b.line === line);
		const items = existing
			? [
					menuItem('remove', t('debugger.gutter.remove')),
					menuItem('edit', t('debugger.gutter.edit')),
					menuItem('toggle', existing.enabled ? t('debugger.gutter.disable') : t('debugger.gutter.enable'))
				]
			: [
					menuItem('add', t('debugger.gutter.add')),
					menuItem('condition', t('debugger.gutter.addConditional')),
					menuItem('log', t('debugger.gutter.addLogpoint')),
					menuItem('triggered', t('debugger.gutter.addTriggered'))
				];
		if (debug.stopped) items.push(menuSeparator, menuItem('runTo', t('debugger.gutter.runToLine')));
		popupMenuAt(e.event.posx, e.event.posy, 'Breakpoint', items, (id) => {
			const language = editor.getModel()?.getLanguageId() ?? '';
			if (id === 'add' || id === 'remove') debug.toggleBreakpoint(p, line, language);
			else if (id === 'edit') void debug.editBreakpoint(p, line);
			else if (id === 'toggle' && existing) debug.setBreakpointEnabled(p, line, !existing.enabled);
			else if (id === 'condition') void debug.editCondition(p, line);
			else if (id === 'log') void debug.editLogMessage(p, line);
			else if (id === 'triggered') void debug.editTrigger(p, line);
			else if (id === 'runTo') void debug.runToCursor(p, line);
		});
	}

	// A glyph margin click toggles a breakpoint; a middle click does `debug.gutterMiddleClickAction`;
	// a click on a test's run icon is the Testing view's (editorTesting.ts).
	const mouse = editor.onMouseDown((e) => {
		if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
		if ((e.target.element as HTMLElement | null)?.closest?.('.kg-test')) return;
		const p = path();
		const line = e.target.position?.lineNumber;
		if (!p || !line) return;
		if (e.event.rightButton) {
			e.event.preventDefault();
			gutterMenu(e, p, line);
		} else if (e.event.leftButton) debug.toggleBreakpoint(p, line, editor.getModel()?.getLanguageId() ?? '');
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
		stoppedKey.set(debug.stopped && !!p);
		jumpKey.set(debug.stopped && !!p && !!debug.capabilities.supportsGotoTargetsRequest);
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
		const caps = debug.active ? debug.capabilities : undefined;
		breakpoints.set(
			glyphs(debug.breakpoints[p], debug.verifiedFor(p), debug.triggered, caps, debug.breakpointsActivated).map((g) => ({
				range: new monaco.Range(g.line, 1, g.line, 1),
				options: { glyphMarginClassName: `kg-bp kg-bp-${g.kind}`, glyphMargin: lane, glyphMarginHoverMessage: { value: g.hover }, stickiness: sticky, ...(ruler && { overviewRuler: ruler }) }
			}))
		);
		const loc = debug.stoppedLocation;
		const top = debug.model?.frames[0]?.id === debug.model?.frameId;
		if (loc && loc.rel === p) {
			frame.set([
				{
					range: new monaco.Range(loc.line, 1, loc.line, 1),
					options: {
						isWholeLine: true,
						className: top ? 'kg-debug-line' : 'kg-debug-line kg-debug-line-focused',
						glyphMarginClassName: top ? 'kg-debug-arrow' : 'kg-debug-arrow kg-debug-arrow-focused',
						glyphMargin: lane,
						stickiness: sticky
					}
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
			actions.forEach((a) => a.dispose());
			breakpoints.clear();
			frame.clear();
			inline.clear();
		}
	};
}
