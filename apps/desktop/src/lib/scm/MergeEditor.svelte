<script lang="ts">
	// The 3-way merge editor (VS Code's mergeEditor, mixed layout): Incoming (stage 3) and Current
	// (stage 2) side by side above, the Result below. The result is the file's own model (edits in
	// it are the file's edits). Every range one side changed has "Accept Incoming / Accept Current /
	// Accept Combination / Ignore" above it; one-sided changes start accepted, conflicts start as
	// the base. Complete Merge saves the file and stages it (git.acceptMerge).
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import type * as Monaco from 'monaco-editor';
	import { clientLog } from '#lib/client-log.ts';
	import { t } from '#lib/i18n/index.ts';
	import { editorOptions } from '#lib/settings/apply.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { modelEntry, saveFile } from '#lib/workbench/editorModels.ts';
	import Icon from '#lib/workbench/Icon.svelte';
	import { ask } from '#lib/workbench/messageBox.ts';
	import { notifications } from '#lib/workbench/notifications.svelte.ts';
	import { scm } from '#lib/workbench/scm.svelte.ts';
	import { fileOf } from '#lib/workbench/scm.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { hasConflictMarkers, parseConflicts } from './conflicts';
	import { diffLines, invertLineChange, mapLine, splitLines } from './lineDiff';
	import { assembleResult, defaultStates, mergeRanges, rangeText, unresolvedCount, type MergeDoc, type RangeState } from './mergeModel';
	import { setTextMinimal } from './quickDiff.svelte';

	let { mergeKey }: { mergeKey: string } = $props();
	const rel = $derived(fileOf(mergeKey));
	const name = $derived(rel.slice(rel.lastIndexOf('/') + 1));

	let top1 = $state<HTMLDivElement>()!;
	let top2 = $state<HTMLDivElement>()!;
	let bottom = $state<HTMLDivElement>()!;
	let error = $state('');
	let doc = $state.raw<MergeDoc | null>(null);
	let states = $state<RangeState[]>([]);
	let names = $state({ incoming: '', current: '' });
	const remaining = $derived(doc ? unresolvedCount(doc, states) : 0);

	let monaco: typeof Monaco | undefined;
	let in1: Monaco.editor.IStandaloneCodeEditor | undefined;
	let in2: Monaco.editor.IStandaloneCodeEditor | undefined;
	let out: Monaco.editor.IStandaloneCodeEditor | undefined;
	let result: Monaco.editor.ITextModel | undefined;
	/** One tracked range per merge range in the result. */
	let tracked: Monaco.editor.IEditorDecorationsCollection | undefined;
	let marks1: Monaco.editor.IEditorDecorationsCollection | undefined;
	let marks2: Monaco.editor.IEditorDecorationsCollection | undefined;
	let zones1: string[] = [];
	let zones2: string[] = [];
	const disposables: Monaco.IDisposable[] = [];

	onMount(() => {
		let disposed = false;
		void (async () => {
			const m = await import('#lib/editor/monaco.ts');
			await m.setupTextMate();
			if (disposed) return;
			monaco = m.monaco;
			const path = rel;
			let texts: [string, string, string];
			try {
				texts = await Promise.all([1, 2, 3].map((stage) => invoke<string>('scm_show_stage', { rel: path, stage }))) as [string, string, string];
			} catch (e) {
				error = String(e);
				return;
			}
			const entry = await modelEntry(m, path).catch((e) => {
				error = String(e);
				return null;
			});
			if (!entry || disposed) return;
			result = entry.model;
			const [base, current, incoming] = texts;
			// The branch names from the markers git wrote (`<<<<<<< HEAD`, `>>>>>>> feature`).
			const first = parseConflicts(result.getValue())[0];
			names = { incoming: first?.incoming.name ?? '', current: first?.current.name ?? '' };
			const language = m.languageFor(path);
			const opts = { ...editorOptions(), theme: m.THEME_ID, automaticLayout: true, minimap: { enabled: false }, glyphMargin: false, folding: false };
			const model = (text: string, side: string) => m.monaco.editor.createModel(text, language, m.monaco.Uri.from({ scheme: 'merge-input', path: `/${side}/${path}` }));
			const model1 = model(incoming, 'incoming');
			const model2 = model(current, 'current');
			in1 = m.monaco.editor.create(top1, { ...opts, readOnly: true, model: model1 });
			in2 = m.monaco.editor.create(top2, { ...opts, readOnly: true, model: model2 });
			out = m.monaco.editor.create(bottom, { ...opts, model: result });
			disposables.push(model1, model2);
			marks1 = in1.createDecorationsCollection();
			marks2 = in2.createDecorationsCollection();
			tracked = out.createDecorationsCollection();

			const d = mergeRanges({ base, input1: incoming, input2: current });
			const initial = defaultStates(d);
			const assembled = assembleResult(d, initial);
			let spans = assembled.spans;
			if (hasConflictMarkers(result.getValue())) setTextMinimal(result, out, assembled.text, 'mergeEditor.init');
			else if (result.getValue() !== assembled.text) {
				// Already edited by hand: each range is found through the edits (from the line above it when edited).
				const toFile = diffLines(splitLines(assembled.text), splitLines(result.getValue())).map(invertLineChange);
				const map = (line0: number) => {
					for (let l = line0 + 1; l >= 1; l--) {
						const at = mapLine(toFile, l);
						if (at !== null) return at - 1 + (line0 + 1 - l);
					}
					return line0;
				};
				spans = spans.map((s) => {
					const start = map(s.start);
					return { start, end: start + (s.end - s.start) };
				});
			}
			doc = d;
			states = initial;
			setTracked(spans);
			drawInputs();
			// Scrolling the result keeps the inputs at the same place in the merge.
			disposables.push(out.onDidScrollChange((e) => e.scrollTopChanged && syncInputs()));
			disposables.push(result.onDidChangeContent(() => drawResult()));
			drawResult();
		})().catch((e) => {
			clientLog('error', `merge editor ${rel}: ${e}`);
			error = String(e);
		});
		return () => {
			disposed = true;
			disposables.forEach((x) => x.dispose());
			in1?.dispose();
			in2?.dispose();
			// The result model is the file's; a file left unsaved stays open in its own tab.
			out?.setModel(null);
			out?.dispose();
			const path = fileOf(mergeKey);
			if (result && !result.isDisposed() && editors.isDirty(path) && !editors.openPaths().has(path)) queueMicrotask(() => editors.open(path, { preview: false }));
		};
	});

	/** The result lines of every range (0-based, end-exclusive) as tracked decorations. */
	function setTracked(spans: { start: number; end: number }[]) {
		if (!monaco || !result || !tracked) return;
		const model = result;
		const sticky = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
		tracked.set(
			spans.map((s, i) => {
				const a = posOfLine(model, s.start);
				const b = posOfLine(model, s.end);
				return { range: new monaco!.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { stickiness: sticky } };
			})
		);
	}

	/** The position where 0-based line `line` starts (the end of the text past the last line). */
	function posOfLine(model: Monaco.editor.ITextModel, line: number): Monaco.IPosition {
		const lines = splitLines(model.getValue());
		let offset = 0;
		for (let i = 0; i < Math.min(line, lines.length); i++) offset += lines[i].length;
		return model.getPositionAt(offset);
	}

	/** The tracked result lines of range `i` (0-based, end-exclusive). */
	function spanOf(i: number): { start: number; end: number } | null {
		const r = tracked?.getRanges()[i];
		if (!r || !result) return null;
		const start = r.startLineNumber - 1;
		const end = r.endColumn === 1 ? r.endLineNumber - 1 : r.endLineNumber;
		return { start, end: Math.max(start, end) };
	}

	function setState(i: number, next: RangeState) {
		if (!doc || !result || !out || !monaco) return;
		const all = tracked!.getRanges();
		const r = all[i];
		if (!r) return;
		const text = rangeText(doc, doc.ranges[i], next);
		const s = posOfLine(result, r.startLineNumber - 1);
		out.pushUndoStop();
		out.executeEdits('mergeEditor.accept', [{ range: new monaco.Range(s.lineNumber, s.column, r.endLineNumber, r.endColumn), text, forceMoveMarkers: false }]);
		out.pushUndoStop();
		states[i] = next;
		// The edited range now covers exactly the new text.
		const spans = doc.ranges.map((_, k) => spanOf(k) ?? { start: 0, end: 0 });
		const start = s.lineNumber - 1;
		spans[i] = { start, end: start + splitLines(text).length };
		setTracked(spans);
		drawInputs();
		drawResult();
	}

	function zoneActions(side: 1 | 2, i: number): HTMLElement {
		const node = document.createElement('div');
		node.className = 'kg-me-actions';
		for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) node.addEventListener(type, (e) => e.stopPropagation());
		const r = doc!.ranges[i];
		const st = states[i];
		const mine = side === 1 ? st.input1 : st.input2;
		const button = (label: string, on: boolean, run: () => void) => {
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = on ? `✓ ${label}` : label;
			if (on) b.className = 'kg-me-on';
			b.addEventListener('click', run);
			node.append(b);
		};
		const other = side === 1 ? st.input2 : st.input1;
		button(side === 1 ? t('scmEditor.merge.acceptIncoming') : t('scmEditor.merge.acceptCurrent'), mine && !other, () =>
			setState(i, side === 1 ? { input1: !mine || other, input2: false } : { input1: false, input2: !mine || other })
		);
		if (r.conflicting) button(t('scmEditor.merge.acceptCombination'), st.input1 && st.input2, () => setState(i, { input1: true, input2: true }));
		if (mine) button(t('scmEditor.merge.ignore'), false, () => setState(i, side === 1 ? { ...st, input1: false } : { ...st, input2: false }));
		return node;
	}

	function drawInputs() {
		if (!doc || !monaco || !in1 || !in2) return;
		const d = doc;
		const m = monaco;
		const draw = (ed: Monaco.editor.IStandaloneCodeEditor, side: 1 | 2, zones: string[], marks: Monaco.editor.IEditorDecorationsCollection) => {
			const items: Monaco.editor.IModelDeltaDecoration[] = [];
			const next: string[] = [];
			ed.changeViewZones((a) => {
				for (const z of zones) a.removeZone(z);
				d.ranges.forEach((r, i) => {
					const changed = side === 1 ? r.changed1 : r.changed2;
					if (!changed) return;
					const span = side === 1 ? r.input1 : r.input2;
					next.push(a.addZone({ afterLineNumber: span.start, heightInPx: 20, domNode: zoneActions(side, i), suppressMouseDown: true }));
					const handled = states[i].input1 || states[i].input2 || !r.conflicting;
					if (span.end > span.start)
						items.push({
							range: new m.Range(span.start + 1, 1, span.end, 1),
							options: { isWholeLine: true, className: side === 1 ? 'kg-me-incoming' : 'kg-me-current', linesDecorationsClassName: r.conflicting ? (handled ? 'kg-me-handled-gutter' : 'kg-me-conflict-gutter') : undefined }
						});
				});
			});
			marks.set(items);
			return next;
		};
		zones1 = draw(in1, 1, zones1, marks1!);
		zones2 = draw(in2, 2, zones2, marks2!);
	}

	let resultMarks: Monaco.editor.IEditorDecorationsCollection | undefined;
	function drawResult() {
		if (!doc || !monaco || !out) return;
		resultMarks ??= out.createDecorationsCollection();
		const m = monaco;
		const items: Monaco.editor.IModelDeltaDecoration[] = [];
		doc.ranges.forEach((r, i) => {
			const s = spanOf(i);
			if (!s || s.end <= s.start) return;
			const open = r.conflicting && !states[i].input1 && !states[i].input2;
			items.push({
				range: new m.Range(s.start + 1, 1, s.end, 1),
				options: { isWholeLine: true, className: open ? 'kg-me-result-conflict' : 'kg-me-result', linesDecorationsClassName: r.conflicting ? (open ? 'kg-me-conflict-gutter' : 'kg-me-handled-gutter') : undefined }
			});
		});
		resultMarks.set(items);
	}

	/** The input line matching result line `line` (0-based), through the ranges. */
	function mapToInput(line: number, side: 1 | 2): number {
		if (!doc) return line;
		let lastResult = 0;
		let lastInput = 0;
		for (let i = 0; i < doc.ranges.length; i++) {
			const s = spanOf(i);
			const span = side === 1 ? doc.ranges[i].input1 : doc.ranges[i].input2;
			if (!s) continue;
			if (line < s.start) return lastInput + (line - lastResult);
			if (line < s.end) return span.start + Math.min(line - s.start, Math.max(0, span.end - span.start - 1));
			lastResult = s.end;
			lastInput = span.end;
		}
		return lastInput + (line - lastResult);
	}

	function syncInputs() {
		if (!out || !in1 || !in2) return;
		const top = (out.getVisibleRanges()[0]?.startLineNumber ?? 1) - 1;
		for (const [ed, side] of [[in1, 1], [in2, 2]] as const) ed.setScrollTop(ed.getTopForLineNumber(mapToInput(top, side) + 1));
	}

	function goToConflict(dir: 1 | -1) {
		if (!doc || !out) return;
		const line = (out.getPosition()?.lineNumber ?? 1) - 1;
		const list = doc.ranges.map((r, i) => ({ r, i, s: spanOf(i) })).filter((x) => x.r.conflicting && x.s);
		if (!list.length) return;
		const pick = dir === 1 ? (list.find((x) => x.s!.start > line) ?? list[0]) : ([...list].reverse().find((x) => x.s!.start < line) ?? list[list.length - 1]);
		out.setPosition({ lineNumber: pick.s!.start + 1, column: 1 });
		out.revealLineInCenter(pick.s!.start + 1);
		out.focus();
	}

	/** git.acceptMerge: save the result and stage it; unhandled conflicts are asked about first. */
	async function complete() {
		if (!result || !doc) return;
		const path = rel;
		if (remaining > 0 || hasConflictMarkers(result.getValue())) {
			const ok = await ask(t('scmEditor.merge.unhandled', { name, count: remaining }), {
				title: t('scmEditor.merge.complete'),
				kind: 'warning',
				okLabel: t('scmEditor.merge.completeAnyway'),
				cancelLabel: t('common.cancel')
			});
			if (!ok) return;
		}
		if (!(await saveFile(path))) return notifications.warn(t('scmEditor.merge.saveFailed', { name }));
		if (await scm.stage([path])) {
			status.flash(t('scmEditor.merge.completed', { name }));
			editors.close(mergeKey, { force: true });
		}
	}

	const TOOL = 'inline-flex h-5 items-center gap-1 rounded px-1.5 hover:bg-(--vscode-toolbar-hoverBackground)';
</script>

<div class="flex h-full w-full flex-col bg-(--vscode-editor-background)">
	{#if error}
		<p class="p-4 text-(--vscode-errorForeground)">{t('scmEditor.merge.failed', { name, error })}</p>
	{:else}
		<div class="flex min-h-0 basis-[45%] border-b border-(--vscode-widget-border)">
			<section class="flex min-w-0 flex-1 flex-col border-r border-(--vscode-widget-border)">
				<header class="flex h-6 shrink-0 items-center gap-2 px-2 text-xs">
					<span class="font-semibold">{t('scmEditor.merge.incoming')}</span>
					<span class="truncate text-(--vscode-descriptionForeground)">{names.incoming}</span>
				</header>
				<div bind:this={top1} class="min-h-0 flex-1"></div>
			</section>
			<section class="flex min-w-0 flex-1 flex-col">
				<header class="flex h-6 shrink-0 items-center gap-2 px-2 text-xs">
					<span class="font-semibold">{t('scmEditor.merge.current')}</span>
					<span class="truncate text-(--vscode-descriptionForeground)">{names.current}</span>
				</header>
				<div bind:this={top2} class="min-h-0 flex-1"></div>
			</section>
		</div>
		<section class="flex min-h-0 flex-1 flex-col">
			<header class="flex h-7 shrink-0 items-center gap-2 px-2 text-xs">
				<span class="font-semibold">{t('scmEditor.merge.result')}</span>
				<span class="truncate text-(--vscode-descriptionForeground)">{rel}</span>
				<span class="text-(--vscode-descriptionForeground)">{remaining ? t('scmEditor.merge.remaining', { count: remaining }) : t('scmEditor.merge.noneRemaining')}</span>
				<span class="flex-1"></span>
				<button class={TOOL} title={t('scmEditor.merge.previousConflict')} aria-label={t('scmEditor.merge.previousConflict')} onclick={() => goToConflict(-1)}><Icon name="arrowUp" size={14} /></button>
				<button class={TOOL} title={t('scmEditor.merge.nextConflict')} aria-label={t('scmEditor.merge.nextConflict')} onclick={() => goToConflict(1)}><Icon name="arrowDown" size={14} /></button>
				<button class="h-5 rounded-sm bg-(--vscode-button-background) px-2 text-(--vscode-button-foreground) hover:brightness-110 disabled:opacity-50" disabled={!doc} onclick={complete}>
					{t('scmEditor.merge.complete')}
				</button>
			</header>
			<div bind:this={bottom} class="min-h-0 flex-1"></div>
		</section>
	{/if}
</div>
