// Tests in a Monaco editor (VS Code: testingDecorations.ts and the testing output peek): a run
// icon in the glyph margin of each test and suite showing its last result (`testing.gutterEnabled`;
// a click does `testing.defaultGutterClickAction`, a right click opens the test menu), the failure
// message after the failing line, and the failure peek with expected and actual values.

import type * as Monaco from 'monaco-editor';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { menuItem } from '#lib/workbench/PopupMenu.svelte';
import { popupMenuAt } from '#lib/workbench/popupMenuAt.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { isJsTestFile, isPythonTestFile } from './discover.ts';
import type { TestItem, TestMessage } from './model.ts';
import { testing } from './testing.svelte.ts';

type MonacoApi = typeof Monaco;
export type TestingDecorations = { render: () => void; dispose: () => void };

const mightHaveTests = (rel: string) => isJsTestFile(rel) || isPythonTestFile(rel) || rel.endsWith('_test.go') || rel.endsWith('.rs');

/** The peek's DOM: the test, its message and, when known, expected and actual (VS Code shows a diff editor there). */
function peekNode(item: TestItem, m: TestMessage, onClose: () => void): HTMLElement {
	const root = document.createElement('div');
	root.className = 'kg-test-peek';
	root.style.cssText =
		'box-sizing:border-box;height:100%;overflow:auto;border-top:2px solid var(--vscode-peekView-border,var(--vscode-testing-peekBorder,#f14c4c));border-bottom:2px solid var(--vscode-peekView-border,var(--vscode-testing-peekBorder,#f14c4c));background:var(--vscode-peekViewEditor-background,var(--vscode-editorWidget-background));font-family:var(--vscode-editor-font-family);font-size:12px;padding:4px 12px;pointer-events:auto;';
	const head = document.createElement('div');
	head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 0 6px;color:var(--vscode-peekViewTitleLabel-foreground,var(--vscode-foreground));';
	const title = document.createElement('span');
	title.textContent = `${item.label} — ${t('testing.failed')}`;
	title.style.cssText = 'flex:1;font-weight:600;';
	const close = document.createElement('button');
	close.textContent = '×';
	close.title = t('testing.closePeek');
	close.style.cssText = 'font-size:16px;line-height:16px;padding:0 4px;color:inherit;background:none;border:none;cursor:pointer;';
	close.onclick = onClose;
	head.append(title, close);
	const pre = document.createElement('pre');
	pre.textContent = m.message;
	pre.style.cssText = 'margin:0 0 6px;white-space:pre-wrap;color:var(--vscode-errorForeground,#f14c4c);';
	root.append(head, pre);
	if (m.expected !== undefined || m.actual !== undefined) {
		const grid = document.createElement('div');
		grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';
		for (const [label, value, color] of [
			[t('testing.expected'), m.expected ?? '', 'var(--vscode-diffEditor-insertedTextBackground,rgba(155,185,85,.2))'],
			[t('testing.actual'), m.actual ?? '', 'var(--vscode-diffEditor-removedTextBackground,rgba(255,0,0,.2))']
		]) {
			const box = document.createElement('div');
			const h = document.createElement('div');
			h.textContent = label;
			h.style.cssText = 'font-weight:600;padding-bottom:2px;color:var(--vscode-descriptionForeground);';
			const v = document.createElement('pre');
			v.textContent = value;
			v.style.cssText = `margin:0;padding:4px;white-space:pre-wrap;background:${color};`;
			box.append(h, v);
			grid.append(box);
		}
		root.append(grid);
	}
	return root;
}

export function attachTestingEditor(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor, path: () => string | null): TestingDecorations {
	const gutter = editor.createDecorationsCollection();
	const messages = editor.createDecorationsCollection();
	const lane = { position: monaco.editor.GlyphMarginLane.Center };
	let zone: string | null = null;
	let zoneKey = '';

	const itemAtLine = (rel: string, line: number) => testing.testsInFile(rel).filter((i) => i.line === line).sort((a, b) => b.path.length - a.path.length)[0];

	function testMenu(x: number, y: number, item: TestItem) {
		const state = testing.stateOf(item);
		const items = [menuItem('run', t('testing.menu.run')), menuItem('debug', t('testing.menu.debug'), { enabled: item.runner !== 'bun' }), menuItem('reveal', t('testing.menu.reveal'))];
		if (state === 'failed' || state === 'errored') items.push(menuItem('peek', t('testing.menu.peek')));
		popupMenuAt(x, y, 'Test', items, (id) => {
			if (id === 'run') void testing.run([item]);
			else if (id === 'debug') void testing.run([item], { debug: true });
			else if (id === 'peek') testing.openPeek(item.id);
			else if (id === 'reveal') {
				layout.sideView = 'testing';
				layout.sidebarVisible = true;
				testing.revealId = item.id;
			}
		});
	}

	const mouse = editor.onMouseDown((e) => {
		if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
		if (!(e.target.element as HTMLElement | null)?.closest?.('.kg-test')) return;
		const p = path();
		const line = e.target.position?.lineNumber;
		const item = p && line ? itemAtLine(p, line) : undefined;
		if (!item) return;
		if (!e.event.leftButton) return;
		e.event.preventDefault();
		const action = settings.get<string>('testing.defaultGutterClickAction');
		if (action === 'contextMenu') setTimeout(() => testMenu(e.event.posx, e.event.posy, item));
		else void testing.run([item], { debug: action === 'debug' });
	});
	const context = editor.onContextMenu((e) => {
		if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
		if (!(e.target.element as HTMLElement | null)?.closest?.('.kg-test')) return;
		const p = path();
		const line = e.target.position?.lineNumber;
		const item = p && line ? itemAtLine(p, line) : undefined;
		if (!item) return;
		e.event.preventDefault();
		testMenu(e.event.posx, e.event.posy, item);
	});

	function renderPeek(p: string) {
		const peek = testing.peek;
		const item = peek && peek.rel === p ? testing.find(peek.itemId) : undefined;
		const message = item ? testing.results.get(item.id)?.messages[peek!.index] : undefined;
		const key = item && message ? `${item.id}|${peek!.line}|${message.message}` : '';
		if (key === zoneKey) return;
		zoneKey = key;
		editor.changeViewZones((acc) => {
			if (zone) acc.removeZone(zone);
			zone = null;
			if (!item || !message || !peek) return;
			const lines = Math.min(18, 4 + message.message.split('\n').length + (message.expected !== undefined || message.actual !== undefined ? 3 : 0));
			zone = acc.addZone({ afterLineNumber: peek.line, heightInLines: lines, domNode: peekNode(item, message, () => testing.closePeek()) });
		});
	}

	function render() {
		const p = path();
		if (!p) {
			gutter.clear();
			messages.clear();
			renderPeek('');
			return;
		}
		if (mightHaveTests(p)) void testing.ensureLoaded();
		// testing.gutterEnabled
		const tests = settings.get<boolean>('testing.gutterEnabled') ? testing.testsInFile(p) : [];
		const lines = new Set<number>();
		gutter.set(
			tests
				.filter((i) => i.line && !lines.has(i.line) && lines.add(i.line))
				.map((i) => {
					const state = testing.stateOf(i);
					const kind = state === 'unset' || state === 'queued' ? '' : state === 'running' ? ' kg-test-running' : ` kg-test-${state}`;
					const label = i.kind === 'suite' ? t('testing.gutter.suite', { name: i.label }) : t('testing.gutter.test', { name: i.label });
					return { range: new monaco.Range(i.line!, 1, i.line!, 1), options: { glyphMarginClassName: `kg-test${kind}`, glyphMargin: lane, glyphMarginHoverMessage: { value: `${label} (${t(`testing.state.${state}`)})` } } };
				})
		);
		const model = editor.getModel();
		messages.set(
			testing
				.messagesIn(p)
				.filter((m) => model && m.message.location!.line <= model.getLineCount())
				.map((m) => {
					const line = m.message.location!.line;
					const first = m.message.message.split('\n').find((l) => l.trim()) ?? '';
					return {
						range: new monaco.Range(line, 1, line, model!.getLineMaxColumn(line)),
						options: {
							isWholeLine: true,
							className: 'kg-test-message-line',
							after: { content: first.length > 120 ? `${first.slice(0, 120)}…` : first, inlineClassName: 'kg-test-message' },
							hoverMessage: { value: `**${m.item.label}**\n\n\`\`\`\n${m.message.message}\n\`\`\`` }
						}
					};
				})
		);
		renderPeek(p);
	}

	return {
		render,
		dispose: () => {
			mouse.dispose();
			context.dispose();
			gutter.clear();
			messages.clear();
			if (zone) editor.changeViewZones((acc) => zone && acc.removeZone(zone));
		}
	};
}
