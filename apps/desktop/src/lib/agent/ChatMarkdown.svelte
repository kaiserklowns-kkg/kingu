<script lang="ts">
	// A response's markdown (VS Code's chatMarkdownContentPart): prose rendered as Markdown (raw HTML
	// shown as text), code blocks in their own box, syntax coloured once the text stopped streaming,
	// with Insert at Cursor (into the active editor), Insert into New File, Insert into Terminal and
	// Copy. Links: web links open in the browser, workspace paths open in the editor.
	import Icon from '#lib/workbench/Icon.svelte';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { trustedDomains } from '#lib/workbench/trustedDomains.svelte.ts';
	import { t } from '#lib/i18n/index.ts';
	import { splitMarkdown } from './chatMarkdown';
	import { shortPath } from './chatParts';
	import { colorize, insertIntoNewFile, insertIntoTerminal } from './chatCodeActions';

	let { text, streaming = false, root = null }: { text: string; streaming?: boolean; root?: string | null } = $props();

	const segments = $derived(splitMarkdown(text));
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
		{:else}
			{@const html = streaming ? undefined : colored[blockKey(seg)]}
			<div class="kg-code group/code">
				<div class="kg-code-head">
					<span class="min-w-0 flex-1 truncate">{seg.lang}</span>
					<button type="button" class="kg-code-btn" title={t('chatView.insertAtCursor')} aria-label={t('chatView.insertAtCursor')} onclick={() => insert(seg.code)}>
						<Icon name="code" size={13} />
					</button>
					<button type="button" class="kg-code-btn" title={t('chatParts.code.newFile')} aria-label={t('chatParts.code.newFile')} onclick={() => void insertIntoNewFile(seg.code, seg.lang)}>
						<Icon name="newFile" size={13} />
					</button>
					<button type="button" class="kg-code-btn" title={t('chatParts.code.terminal')} aria-label={t('chatParts.code.terminal')} onclick={() => insertIntoTerminal(seg.code)}>
						<Icon name="terminal" size={13} />
					</button>
					<button type="button" class="kg-code-btn" title={t('chatView.copyCode')} aria-label={t('chatView.copyCode')} onclick={() => copy(seg.code, i)}>
						<Icon name={copied === i ? 'check' : 'copy'} size={13} />
					</button>
				</div>
				<!-- Safe: Monaco's colorizer escapes the text and only adds token spans. -->
				{#if html}<pre><code>{@html html}</code></pre>{:else}<pre><code>{seg.code}</code></pre>{/if}
			</div>
		{/if}
	{/each}
	{#if streaming}<span class="kg-caret" aria-hidden="true"></span>{/if}
</div>

<style>
	.kg-md {
		line-height: 1.55;
		color: var(--vscode-foreground);
		overflow-wrap: break-word;
	}
	.kg-md :global(> :first-child) {
		margin-top: 0;
	}
	.kg-md :global(p),
	.kg-md :global(ul),
	.kg-md :global(ol),
	.kg-md :global(blockquote),
	.kg-md :global(table) {
		margin: 0 0 0.6em;
	}
	.kg-md :global(h1),
	.kg-md :global(h2),
	.kg-md :global(h3),
	.kg-md :global(h4) {
		font-weight: 600;
		margin: 0.9em 0 0.4em;
	}
	.kg-md :global(h1) {
		font-size: 1.3em;
	}
	.kg-md :global(h2) {
		font-size: 1.15em;
	}
	.kg-md :global(h3) {
		font-size: 1.05em;
	}
	.kg-md :global(ul) {
		list-style: disc;
		padding-left: 1.4em;
	}
	.kg-md :global(ol) {
		list-style: decimal;
		padding-left: 1.4em;
	}
	.kg-md :global(a) {
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
	}
	.kg-md :global(a:hover) {
		text-decoration: underline;
	}
	.kg-md :global(code) {
		font-family: var(--vscode-editor-font-family, Menlo, monospace);
		font-size: var(--kg-chat-code-size, 0.9em);
		padding: 0.1em 0.3em;
		border-radius: 4px;
		background: var(--vscode-textCodeBlock-background, rgb(128 128 128 / 0.16));
	}
	.kg-md :global(blockquote) {
		padding: 0 0.8em;
		color: var(--vscode-descriptionForeground);
		border-left: 3px solid var(--vscode-widget-border);
	}
	.kg-md :global(table) {
		border-collapse: collapse;
		display: block;
		overflow-x: auto;
	}
	.kg-md :global(th),
	.kg-md :global(td) {
		padding: 3px 8px;
		border: 1px solid var(--vscode-widget-border);
	}
	.kg-md :global(th) {
		font-weight: 600;
	}
	.kg-md :global(hr) {
		margin: 1em 0;
		border: 0;
		border-top: 1px solid var(--vscode-widget-border);
	}
	.kg-code {
		margin: 0 0 0.6em;
		border: 1px solid var(--vscode-widget-border);
		border-radius: 6px;
		background: var(--vscode-editor-background);
		overflow: hidden;
	}
	.kg-code-head {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 24px;
		padding: 0 4px 0 8px;
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		border-bottom: 1px solid var(--vscode-widget-border);
	}
	.kg-code-btn {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: 4px;
	}
	.kg-code-btn:hover {
		background: var(--vscode-toolbar-hoverBackground);
		color: var(--vscode-foreground);
	}
	.kg-code pre {
		margin: 0;
		padding: 8px 10px;
		overflow-x: auto;
	}
	.kg-code pre code {
		padding: 0;
		background: none;
		white-space: pre;
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
