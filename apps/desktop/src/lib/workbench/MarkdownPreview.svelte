<script lang="ts">
	// Markdown: Open Preview (VS Code ⇧⌘V, Orca's MarkdownPreview). Follows the open editor's
	// unsaved text live; otherwise reads the file. Scrolls with the editor and back
	// (markdown.preview.scroll*), marks the editor's line (markEditorSelection), double-click goes
	// to the source line. An unlocked preview in another group follows the active Markdown editor.
	// Links to workspace files open them; http(s) links open in the browser (Rust checks the
	// scheme); other schemes are never followed. Workspace images load through the guarded
	// `fs_read_data_url`; remote images are not loaded.
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import { editors } from './editors.svelte';
	import { status } from './status.svelte';
	import { isMarkdownPath, PREVIEW_PREFIX, previewKey, previewTarget } from './viewers';
	import { watchSource } from './viewerSource';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { openUrl } from '#lib/terminal/pty.ts';
	import { mayHaveMath, renderPreview, type MathRenderer, type PreviewOptions } from '#lib/markdown/previewRender.ts';
	import { blockIndexForLine, lineForScrollTop, normalizeBlocks, scrollTopForLine, type Block } from '#lib/markdown/previewScroll.ts';
	import { followRemap, imageRel, linkTarget } from '#lib/markdown/previewModel.ts';
	import { cursorLine, editorTopLine, onEditorSync, scrollEditorsTo } from '#lib/markdown/previewSync.ts';
	import { previewLocks } from '#lib/markdown/previewLocks.svelte.ts';
	import { slugify } from '#lib/markdown/slugify.ts';

	let { previewKey: key, group }: { previewKey: string; group?: number } = $props();
	const rel = $derived(previewTarget(key));

	let source = $state('');
	let error = $state('');
	let math = $state.raw<MathRenderer | null>(null);
	let scroller = $state<HTMLDivElement>();
	let article = $state<HTMLElement>();
	/** The editor's cursor line (0-based), for markEditorSelection. */
	let selectedLine = $state<number | null>(null);

	$effect(() => {
		error = '';
		return watchSource(rel, (text) => (source = text), (e) => (error = e));
	});

	const options = $derived<PreviewOptions>({
		breaks: settings.get<boolean>('markdown.preview.breaks'),
		linkify: settings.get<boolean>('markdown.preview.linkify'),
		typographer: settings.get<boolean>('markdown.preview.typographer'),
		math: settings.get<boolean>('markdown.math.enabled')
	});
	const fontSize = $derived(settings.get<number>('markdown.preview.fontSize'));
	const lineHeight = $derived(settings.get<number>('markdown.preview.lineHeight'));
	const fontFamily = $derived(settings.get<string>('markdown.preview.fontFamily'));
	const markSelection = $derived(settings.get<boolean>('markdown.preview.markEditorSelection'));

	// KaTeX loads the first time a document has math.
	$effect(() => {
		if (math || !options.math || !mayHaveMath(source)) return;
		void import('#lib/markdown/katex.ts').then((m) => (math = m.renderMath)).catch(() => {});
	});

	const html = $derived(renderPreview(source, options, math));

	// --- Images: workspace files as data URLs (cached while the preview is open) ----------------

	const images = new Map<string, Promise<string>>();

	function placeholder(img: HTMLImageElement, title: string) {
		const span = document.createElement('span');
		span.className = 'md-image-placeholder';
		span.title = title;
		span.textContent = `🖼 ${img.alt || img.dataset.src || ''}`;
		img.replaceWith(span);
	}

	function loadImages(root: HTMLElement) {
		for (const img of root.querySelectorAll<HTMLImageElement>('img[data-src]')) {
			const src = img.dataset.src ?? '';
			const target = imageRel(rel, src);
			if (target === null) {
				placeholder(img, t('markdownPreview.remoteImage', { src }));
				continue;
			}
			let url = images.get(target);
			if (!url) images.set(target, (url = invoke<string>('fs_read_data_url', { rel: target })));
			url.then((u) => img.isConnected && (img.src = u)).catch(() => img.isConnected && placeholder(img, t('markdownPreview.imageFailed', { src })));
		}
	}

	// --- Scroll sync -----------------------------------------------------------------------------

	/** Until when the preview's own scroll events are not passed to the editor (it was scrolled by it). */
	let quietUntil = 0;

	function blocks(): Block[] {
		if (!scroller || !article) return [];
		const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
		const list: Block[] = [];
		for (const el of article.querySelectorAll<HTMLElement>('[data-line]')) list.push({ line: Number(el.dataset.line), top: el.getBoundingClientRect().top - base });
		return normalizeBlocks(list);
	}

	function scrollToLine(line: number) {
		if (!scroller) return;
		quietUntil = Date.now() + 120;
		scroller.scrollTop = scrollTopForLine(blocks(), line);
	}

	function onscroll() {
		if (Date.now() < quietUntil || !scroller || !settings.get<boolean>('markdown.preview.scrollEditorWithPreview')) return;
		const model = editors.textModel(rel);
		if (model) scrollEditorsTo(model, lineForScrollTop(blocks(), scroller.scrollTop));
	}

	$effect(() =>
		onEditorSync((e) => {
			if (e.model !== editors.textModel(rel)) return;
			if (e.kind === 'selection') selectedLine = e.line;
			else if (settings.get<boolean>('markdown.preview.scrollPreviewWithEditor')) scrollToLine(e.line);
		})
	);

	// After each render: images, the marked line, and (first render) the editor's scroll position.
	let placed = false;
	$effect(() => {
		void html;
		const root = article;
		if (!root) return;
		untrack(() => {
			loadImages(root);
			const model = editors.textModel(rel);
			if (!placed && source && model) {
				placed = true;
				selectedLine = cursorLine(model);
				const top = editorTopLine(model);
				if (top !== null && settings.get<boolean>('markdown.preview.scrollPreviewWithEditor')) scrollToLine(top);
			}
		});
	});

	$effect(() => {
		void html;
		const root = article;
		if (!root) return;
		for (const el of root.querySelectorAll('.md-selected-line')) el.classList.remove('md-selected-line');
		if (!markSelection || selectedLine === null) return;
		const els = [...root.querySelectorAll<HTMLElement>('[data-line]')];
		const i = blockIndexForLine(els.map((el) => Number(el.dataset.line)), selectedLine);
		if (i >= 0) els[i].classList.add('md-selected-line');
	});

	// --- An unlocked preview follows the active Markdown editor (in another group) -------------

	$effect(() => {
		const active = editors.active;
		const activeGroup = editors.activeGroupId;
		if (!active || group === undefined || group === activeGroup) return;
		untrack(() => {
			const shown = editors.model.groups.filter((g) => g.active).map((g) => ({ group: g.id, key: g.active! }));
			const map = followRemap(shown, activeGroup, active, previewLocks.keys, PREVIEW_PREFIX, isMarkdownPath);
			if (map.has(key)) editors.remap((p) => (p === key ? map.get(key)! : null));
		});
	});

	// --- Links, double-click ---------------------------------------------------------------------

	function scrollToFragment(fragment: string) {
		const el = article?.querySelector(`[id="${CSS.escape(slugify(fragment))}"]`) ?? article?.querySelector(`[id="${CSS.escape(fragment)}"]`);
		el?.scrollIntoView({ block: 'start' });
	}

	function onclick(e: MouseEvent | KeyboardEvent) {
		if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
		const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-href]');
		if (!a) return;
		e.preventDefault();
		const href = a.dataset.href ?? '';
		const target = linkTarget(rel, href);
		switch (target.kind) {
			case 'fragment':
				return scrollToFragment(target.fragment);
			case 'local':
			case 'external':
				return void openUrl(target.url, ['http', 'https', 'mailto']).catch((err) => status.error(t('markdownPreview.linkFailed', { error: String(err) })));
			case 'blocked':
				return void navigator.clipboard.writeText(target.url).then(() => status.flash(t('markdownPreview.linkCopied', { url: target.url }), 4000));
			case 'file':
				if (target.rel === rel && target.fragment) return scrollToFragment(target.fragment);
				if (isMarkdownPath(target.rel) && settings.get<string>('markdown.preview.openMarkdownLinks') === 'inPreview') return editors.open(previewKey(target.rel), { preview: false, group });
				return editors.open(target.rel, { preview: false });
		}
	}

	function ondblclick(e: MouseEvent) {
		if (!settings.get<boolean>('markdown.preview.doubleClickToSwitchToEditor')) return;
		const el = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
		const line = el ? Number(el.dataset.line) + 1 : 1;
		e.preventDefault();
		const g = editors.model.groups.find((x) => x.id !== group && x.tabs.some((tab) => tab.path === rel))?.id;
		editors.open(rel, { preview: false, group: g, reveal: { line, column: 1, focus: true } });
		if (g !== undefined) editors.focusGroup(g);
	}
</script>

<div class="h-full overflow-y-auto bg-(--vscode-editor-background)" bind:this={scroller} {onscroll}>
	{#if error}
		<p class="p-6 text-[13px] text-(--vscode-errorForeground)">{t('markdownPreview.openFailed', { error })}</p>
	{:else}
		<!-- Link clicks are delegated here; the links themselves stay keyboard-reachable anchors. -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<article
			class="markdown-body kg-selectable mx-auto max-w-[860px] px-8 py-6"
			style:font-size="{fontSize}px"
			style:line-height={lineHeight}
			style:font-family={fontFamily}
			title={previewLocks.isLocked(key) ? t('markdownPreview.locked', { name: rel }) : undefined}
			bind:this={article}
			{onclick}
			onkeydown={onclick}
			{ondblclick}
		>
			<!-- Safe: renderPreview escapes raw HTML; links and images keep their URL in data attributes (previewRender.ts). -->
			{@html html}
		</article>
	{/if}
</div>

<style>
	.markdown-body {
		color: var(--vscode-editor-foreground);
		overflow-wrap: break-word;
	}
	.markdown-body :global(h1),
	.markdown-body :global(h2) {
		padding-bottom: 0.3em;
		border-bottom: 1px solid var(--vscode-widget-border);
	}
	.markdown-body :global(h1) {
		font-size: 2em;
		font-weight: 600;
		margin: 0.4em 0 0.6em;
	}
	.markdown-body :global(h2) {
		font-size: 1.5em;
		font-weight: 600;
		margin: 1.4em 0 0.6em;
	}
	.markdown-body :global(h3) {
		font-size: 1.25em;
		font-weight: 600;
		margin: 1.2em 0 0.5em;
	}
	.markdown-body :global(h4),
	.markdown-body :global(h5),
	.markdown-body :global(h6) {
		font-weight: 600;
		margin: 1em 0 0.4em;
	}
	.markdown-body :global(p),
	.markdown-body :global(ul),
	.markdown-body :global(ol),
	.markdown-body :global(blockquote),
	.markdown-body :global(pre),
	.markdown-body :global(table) {
		margin: 0 0 1em;
	}
	.markdown-body :global(ul) {
		list-style: disc;
		padding-left: 1.6em;
	}
	.markdown-body :global(ol) {
		list-style: decimal;
		padding-left: 1.6em;
	}
	.markdown-body :global(li > input[type='checkbox']) {
		margin-right: 0.4em;
	}
	.markdown-body :global(a) {
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
	}
	.markdown-body :global(a:hover) {
		text-decoration: underline;
	}
	.markdown-body :global(code) {
		font-family: var(--vscode-editor-font-family, Menlo, monospace);
		font-size: 0.9em;
		padding: 0.15em 0.35em;
		border-radius: 5px;
		background: rgb(128 128 128 / 0.16);
	}
	.markdown-body :global(pre) {
		padding: 12px 14px;
		border-radius: 8px;
		background: rgb(128 128 128 / 0.12);
		overflow-x: auto;
	}
	.markdown-body :global(pre code) {
		padding: 0;
		background: none;
	}
	.markdown-body :global(blockquote) {
		padding: 0 1em;
		color: var(--vscode-descriptionForeground);
		border-left: 3px solid var(--vscode-widget-border);
	}
	.markdown-body :global(table) {
		border-collapse: collapse;
		display: block;
		overflow-x: auto;
	}
	.markdown-body :global(th),
	.markdown-body :global(td) {
		padding: 6px 12px;
		border: 1px solid var(--vscode-widget-border);
	}
	.markdown-body :global(th) {
		font-weight: 600;
	}
	.markdown-body :global(hr) {
		margin: 1.5em 0;
		border: 0;
		border-top: 1px solid var(--vscode-widget-border);
	}
	.markdown-body :global(img.md-image) {
		max-width: 100%;
	}
	.markdown-body :global(.md-image-placeholder) {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 6px;
		border: 1px dashed var(--vscode-widget-border);
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
	}
	.markdown-body :global(.md-math-block) {
		margin: 0 0 1em;
		overflow-x: auto;
	}
	/* markEditorSelection: a bar beside the block holding the editor's cursor line (VS Code's code-active-line). */
	.markdown-body :global(.md-selected-line) {
		position: relative;
	}
	.markdown-body :global(.md-selected-line::before) {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: -14px;
		border-left: 3px solid var(--vscode-editorLineNumber-activeForeground, var(--vscode-textLink-foreground));
	}
</style>
