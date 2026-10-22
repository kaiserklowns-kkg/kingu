<script lang="ts">
	// A response's markdown (VS Code's chatMarkdownContentPart): prose rendered as Markdown (raw HTML
	// shown as text), code blocks in their own box, syntax coloured once the text stopped streaming,
	// with Insert at Cursor (into the active editor), Insert into New File, Insert into Terminal and
	// Copy. Links: web links open in the browser, workspace paths open in the editor.
	// chat.math.enabled: `$…$` / `$$…$$` with KaTeX and ```mermaid blocks as diagrams (an image,
	// with Show Source), both loaded on first use (chatRich.svelte.ts).
	import Codicon from '#lib/workbench/Codicon.svelte';
	import { codiconOf } from './chatIcons.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { trustedDomains } from '#lib/workbench/trustedDomains.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { mayHaveMath, splitMarkdown } from './chatMarkdown';
	import { shortPath } from './chatParts';
	import { colorize, insertIntoNewFile, insertIntoTerminal } from './chatCodeActions';
	import { chatMath, renderMermaid } from './chatRich.svelte.ts';

	let { text, streaming = false, root = null }: { text: string; streaming?: boolean; root?: string | null } = $props();

	const mathOn = $derived(settings.get<boolean>('chat.math.enabled') !== false);
	$effect(() => {
		if (mathOn && mayHaveMath(text)) chatMath.load();
	});
	const segments = $derived(splitMarkdown(text, { math: mathOn, renderMath: chatMath.renderer }));
	/** Mermaid diagrams by source: the image, or why it could not be drawn. */
	let diagrams = $state<Record<string, { url?: string; error?: string }>>({});
	/** Diagrams shown as their source instead (by segment index). */
	let source = $state<Record<number, boolean>>({});
	$effect(() => {
		if (streaming) return;
		const dark = document.documentElement.dataset.themeType === 'dark';
		for (const seg of segments) {
			if (seg.kind !== 'mermaid' || diagrams[seg.code]) continue;
			const code = seg.code;
			diagrams[code] = {};
			renderMermaid(code, dark).then(
				(url) => (diagrams[code] = { url }),
				(e) => (diagrams[code] = { error: String(e?.message ?? e) })
			);
		}
	});
	let copied = $state(-1);
	/** Coloured code blocks by `lang\0code` (Monaco's colorizer), once the text stopped streaming. */
	let colored = $state<Record<string, string>>({});
	const blockKey = (seg: { lang: string; code: string }) => `${seg.lang}\u0000${seg.code}`;

	$effect(() => {
		if (streaming) return;
		for (const seg of segments) {
			if (seg.kind !== 'code' || !seg.lang) continue;
			const key = blockKey(seg);
			if (colored[key] !== undefined) continue;
			void colorize(seg.code, seg.lang).then((html) => {
				if (html !== null) colored[key] = html;
			});
		}
	});

	async function copy(code: string, i: number) {
		try {
			await navigator.clipboard.writeText(code);
			copied = i;
			setTimeout(() => copied === i && (copied = -1), 1500);
		} catch (e) {
			status.flash(t('chatView.copyFailed', { error: String(e) }), 5000);
		}
	}

	function insert(code: string) {
		if (!editors.insertText(code)) status.flash(t('chatView.noEditor'), 5000);
	}

	function onclick(e: MouseEvent | KeyboardEvent) {
		if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
		const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-href]');
		if (!a) return;
		e.preventDefault();
		const href = a.dataset.href ?? '';
		if (/^https?:\/\//i.test(href)) {
			// Outgoing link protection: a model's link to an untrusted domain asks first.
			void trustedDomains.openLink(href, { fromWorkspace: false });
			return;
		}
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) return;
		// A file link: `src/x.ts`, `/abs/src/x.ts`, `file:///…`, optionally `#L12`.
		const [path, frag] = href.replace(/^file:\/\//, '').split('#');
		const rel = shortPath(decodeURIComponent(path), root);
		const line = /^L(\d+)/.exec(frag ?? '')?.[1];
		if (line) editors.openAt(rel, Number(line));
		else editors.open(rel);
	}
</script>

<!-- Link clicks are delegated here; the links stay keyboard-reachable anchors. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="kg-md" {onclick} onkeydown={onclick} role="presentation">
	{#each segments as seg, i (i)}
		{#if seg.kind === 'markdown'}
			<!-- Safe: renderMarkdown escapes raw HTML and drops images (workbench/markdown.ts). -->
			{@html seg.html}
		{:else if seg.kind === 'mermaid'}
			{@const d = streaming ? undefined : diagrams[seg.code]}
			<div class="kg-code interactive-result-code-block" data-code>
				<div class="interactive-result-code-block-toolbar">
					<div class="monaco-toolbar" role="toolbar" aria-label={t('chatRender.mermaid.label')}>
					{#if d?.url}
						<button type="button" class="kg-code-btn action-label" title={source[i] ? t('chatRender.mermaid.diagram') : t('chatRender.mermaid.source')} aria-label={source[i] ? t('chatRender.mermaid.diagram') : t('chatRender.mermaid.source')} aria-pressed={!!source[i]} onclick={() => (source[i] = !source[i])}>
							<Codicon id={codiconOf(source[i] ? 'image' : 'code')} size={13} />
						</button>
					{/if}
					<button type="button" class="kg-code-btn action-label" title={t('chatView.copyCode')} aria-label={t('chatView.copyCode')} onclick={() => copy(seg.code, i)}>
						<Codicon id={copied === i ? 'check' : 'copy'} size={13} />
					</button>
					</div>
				</div>
				{#if d?.url && !source[i]}
					<div class="kg-diagram"><img src={d.url} alt={t('chatRender.mermaid.label')} /></div>
				{:else}
					{#if d?.error}<p class="kg-diagram-note" role="note">{t('chatRender.mermaid.failed', { error: d.error })}</p>{:else if d && !d.url}<p class="kg-diagram-note" role="status">{t('chatRender.mermaid.drawing')}</p>{/if}
					<pre><code>{seg.code}</code></pre>
				{/if}
			</div>
		{:else}
			{@const html = streaming ? undefined : colored[blockKey(seg)]}
			<div class="kg-code interactive-result-code-block" data-code data-lang={seg.lang || undefined}>
				<!-- VS Code's code block toolbar: on the block's top edge while it is hovered or focused. -->
				<div class="interactive-result-code-block-toolbar">
					<div class="monaco-toolbar" role="toolbar" aria-label={seg.lang || t('chatView.copyCode')}>
					<button type="button" class="kg-code-btn action-label" title={t('chatView.insertAtCursor')} aria-label={t('chatView.insertAtCursor')} onclick={() => insert(seg.code)}>
						<Codicon id="code" size={13} />
					</button>
					<button type="button" class="kg-code-btn action-label" title={t('chatParts.code.newFile')} aria-label={t('chatParts.code.newFile')} onclick={() => void insertIntoNewFile(seg.code, seg.lang)}>
						<Codicon id="new-file" size={13} />
					</button>
					<button type="button" class="kg-code-btn action-label" title={t('chatParts.code.terminal')} aria-label={t('chatParts.code.terminal')} onclick={() => insertIntoTerminal(seg.code)}>
						<Codicon id="terminal" size={13} />
					</button>
					<button type="button" class="kg-code-btn action-label" title={t('chatView.copyCode')} aria-label={t('chatView.copyCode')} onclick={() => copy(seg.code, i)}>
						<Codicon id={copied === i ? 'check' : 'copy'} size={13} />
					</button>
					</div>
				</div>
				<!-- Safe: Monaco's colorizer escapes the text and only adds token spans. -->
				{#if html}<pre><code>{@html html}</code></pre>{:else}<pre><code>{seg.code}</code></pre>{/if}
			</div>
		{/if}
	{/each}
	{#if streaming}<span class="kg-caret" aria-hidden="true"></span>{/if}
</div>

<style>
	/* Markdown as kingu-old's chat draws it (chat.css `.interactive-item-container .value .rendered-markdown`). */
	.kg-md {
		line-height: 1.5em;
		color: var(--vscode-foreground);
		overflow-wrap: anywhere;
	}
	.kg-md :global(> :first-child) {
		margin-top: 0;
	}
	.kg-md :global(p) {
		margin: 0 0 16px 0;
	}
	.kg-md :global(ul),
	.kg-md :global(ol),
	.kg-md :global(blockquote),
	.kg-md :global(table) {
		margin: 0 0 16px;
	}
	.kg-md :global(> :last-child),
	.kg-md :global(> :last-child > :last-child) {
		margin-bottom: 0;
	}
	.kg-md :global(h1),
	.kg-md :global(h2),
	.kg-md :global(h3),
	.kg-md :global(h4) {
		font-weight: var(--vscode-fontWeight-semiBold, 600);
		margin: 1.5em 0 0.875em 0;
	}
	.kg-md :global(h1) {
		font-size: var(--vscode-chat-font-size-body-xxl, 1.538em);
	}
	.kg-md :global(h2) {
		font-size: var(--vscode-chat-font-size-body-xl, 1.231em);
	}
	.kg-md :global(h3) {
		font-size: var(--vscode-chat-font-size-body-l, 1.077em);
	}
	.kg-md :global(strong) {
		font-weight: var(--vscode-fontWeight-semiBold, 600);
	}
	.kg-md :global(ul) {
		list-style: disc;
		padding-inline-start: 24px;
	}
	.kg-md :global(ol) {
		list-style: decimal;
		padding-inline-start: 28px;
	}
	.kg-md :global(li) {
		margin: 4px 0;
	}
	.kg-md :global(a) {
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
	}
	.kg-md :global(a:hover),
	.kg-md :global(a:active) {
		color: var(--vscode-textLink-activeForeground);
	}
	/* Inline code (chat.css `.interactive-item-container code`). */
	.kg-md :global(code) {
		font-family: var(--vscode-editor-font-family, Menlo, monospace);
		font-size: var(--kg-chat-code-size, var(--vscode-chat-font-size-body-xs, 0.846em));
		color: var(--vscode-textPreformat-foreground);
		padding: var(--vscode-spacing-size20, 2px) var(--vscode-spacing-size40, 4px);
		border-radius: var(--vscode-cornerRadius-small, 6px);
		border: var(--vscode-strokeThickness, 1px) solid var(--vscode-textPreformat-border, transparent);
		background-color: var(--vscode-textPreformat-background);
		white-space: pre-wrap;
	}
	.kg-md :global(a code) {
		color: var(--vscode-textLink-foreground);
	}
	.kg-md :global(blockquote) {
		margin: 0 0 16px;
		padding: 0 16px 0 10px;
		border-left: 5px solid var(--vscode-textBlockQuote-border);
		border-radius: var(--vscode-cornerRadius-xSmall, 4px);
		background: var(--vscode-textBlockQuote-background);
	}
	.kg-md :global(table) {
		display: block;
		overflow-x: auto;
		text-align: left;
		border-collapse: separate;
		border-spacing: 0;
		border: var(--vscode-strokeThickness, 1px) solid var(--vscode-chat-requestBorder);
		border-radius: var(--vscode-cornerRadius-medium, 8px);
	}
	.kg-md :global(th),
	.kg-md :global(td) {
		padding: 4px 6px;
		border: var(--vscode-strokeThickness, 1px) solid var(--vscode-chat-requestBorder);
		border-top: none;
		border-left: none;
	}
	.kg-md :global(th:last-child),
	.kg-md :global(td:last-child) {
		border-right: none;
	}
	.kg-md :global(tbody tr:last-child td) {
		border-bottom: none;
	}
	.kg-md :global(th) {
		font-weight: 600;
	}
	.kg-md :global(hr) {
		margin: 1em 0;
		border: 0;
		border-top: 1px solid color-mix(in srgb, var(--vscode-textSeparator-foreground, var(--vscode-widget-border)) 33%, transparent);
	}
	/* A code block (codeBlockPart.css): a framed editor, its toolbar on its top edge on hover. */
	.kg-code {
		position: relative;
		margin: 0 0 16px;
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: var(--vscode-cornerRadius-medium, 8px);
		background: var(--vscode-interactive-result-editor-background-color, var(--vscode-editor-background));
	}
	.kg-code:last-child {
		margin-bottom: 0;
	}
	.kg-code:focus-within {
		border-color: var(--vscode-focusBorder, transparent);
	}
	.interactive-result-code-block-toolbar {
		opacity: 0;
		pointer-events: none;
	}
	.kg-code:hover .interactive-result-code-block-toolbar,
	.interactive-result-code-block-toolbar:focus-within {
		opacity: 1;
		pointer-events: auto;
	}
	.interactive-result-code-block-toolbar > .monaco-toolbar {
		position: absolute;
		top: -15px;
		right: 10px;
		z-index: 100;
		display: flex;
		align-items: center;
		max-width: 70%;
		height: 26px;
		box-sizing: border-box;
		overflow: hidden;
		background-color: var(--vscode-interactive-result-editor-background-color, var(--vscode-editor-background));
		border: 1px solid var(--vscode-chat-requestBorder);
		border-radius: var(--vscode-cornerRadius-medium, 8px);
	}
	.kg-code-btn {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		margin: 1px 2px;
		border-radius: var(--vscode-cornerRadius-small, 6px);
		color: var(--vscode-icon-foreground);
	}
	.kg-code-btn:hover {
		background: var(--vscode-toolbar-hoverBackground);
		color: var(--vscode-foreground);
	}
	.kg-code-btn :global(.codicon) {
		font-size: 16px !important;
	}
	/* chat.editor.*: the code blocks' font, weight, line height and wrapping (ChatList sets them). */
	.kg-code pre {
		margin: 0;
		padding: 8px 12px;
		overflow-x: auto;
		line-height: var(--kg-chat-code-line, normal);
	}
	.kg-code pre code {
		padding: 0;
		background: none;
		white-space: var(--kg-chat-code-wrap, pre);
		overflow-wrap: anywhere;
		font-family: var(--kg-chat-code-font, var(--vscode-editor-font-family, Menlo, monospace));
		font-weight: var(--kg-chat-code-weight, normal);
	}
	.kg-diagram {
		padding: 8px;
		overflow-x: auto;
		text-align: center;
	}
	.kg-diagram img {
		display: inline-block;
		max-width: 100%;
		height: auto;
	}
	.kg-diagram-note {
		margin: 0;
		padding: 4px 10px 0;
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
	}
	.kg-md :global(.md-math-block) {
		margin: 0 0 0.6em;
		overflow-x: auto;
	}
	.kg-caret {
		display: inline-block;
		width: 0.5em;
		height: 1em;
		vertical-align: text-bottom;
		background: currentColor;
		opacity: 0.6;
		animation: kg-blink 1s steps(2) infinite;
	}
	@keyframes kg-blink {
		50% {
			opacity: 0;
		}
	}
</style>
