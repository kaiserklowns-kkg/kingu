<script lang="ts">
	// An artifact in an editor tab (`artifact:<id>:<root>`, or `artifact:team:<id>` for a teammate's
	// shared one, read-only): a header with its versions and actions (Export, Share with team,
	// Delete), then the page in a sandboxed iframe. The page is untrusted agent output: the frame
	// gets `sandbox="allow-scripts"` only (an opaque origin, no popups, forms or top navigation) and
	// its document comes from Rust's `kingu-artifact:` scheme with its own CSP (artifacts/preview.rs).
	// Link clicks inside it arrive as messages; web links open in the browser.
	import { untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { theme } from '#lib/theme/theme.svelte.ts';
	import { team } from '#lib/team/team.svelte.ts';
	import { locale, t } from '#lib/i18n/index.ts';
	import { artifacts } from './artifacts.svelte';
	import { formatSize, latest, linkToOpen, parseArtifactKey, PREVIEW_ALLOW, PREVIEW_SANDBOX, versionSize, type ArtifactMeta, type TeamArtifact } from './artifacts';

	let { artifactKey: key }: { artifactKey: string } = $props();
	const ref = $derived(parseArtifactKey(key));

	let meta = $state<ArtifactMeta | null>(null);
	let shared = $state<TeamArtifact | null>(null);
	let version = $state<number | null>(null);
	let url = $state<string | null>(null);
	let error = $state('');
	let busy = $state(false);
	let frame = $state<HTMLIFrameElement | undefined>();
	/** Bumped by Reload. */
	let reloads = $state(0);

	const revision = $derived(ref && !ref.team ? artifacts.revision(ref.root, ref.id) : 0);
	const current = $derived(meta && version !== null ? (meta.versions.find((v) => v.version === version) ?? null) : null);

	/** The revision last shown: a newer one (the agent published again) switches to the latest version. */
	let shownRevision = -1;

	// The artifact's metadata (again after every change Rust reports for it, and on Reload).
	$effect(() => {
		const r = ref;
		const rev = revision;
		void reloads;
		error = '';
		if (!r) return;
		let stale = false;
		if (r.team) {
			invoke<TeamArtifact>('team_artifact_get', { serverUrl: untrack(() => team.serverUrl), id: r.id })
				.then((a) => {
					if (stale) return;
					shared = a;
					version = a.version;
				})
				.catch((e) => !stale && (error = String(e)));
		} else {
			invoke<ArtifactMeta>('artifact_get', { root: r.root, id: r.id })
				.then((m) => {
					if (stale) return;
					meta = m;
					const wanted = untrack(() => artifacts.takeWanted(key));
					const picked = untrack(() => version);
					const keep = rev === shownRevision && picked !== null && m.versions.some((v) => v.version === picked);
					version = wanted ?? (keep ? picked : latest(m).version);
					shownRevision = rev;
				})
				.catch((e) => !stale && (error = String(e)));
		}
		return () => (stale = true);
	});

	// The preview of the shown version: registered with Rust, released when it changes or the tab closes.
	$effect(() => {
		const r = ref;
		const v = version;
		const m = meta;
		const s = shared;
		void theme.current.type;
		url = null;
		if (!r || v === null) return;
		let token: string | null = null;
		let stale = false;
		const done = (p: { url: string; token: string }) => {
			if (stale) return void invoke('artifact_preview_close', { token: p.token });
			token = p.token;
			url = p.url;
		};
		const fail = (e: unknown) => !stale && (error = String(e));
		if (r.team) {
			if (s?.html) invoke<{ url: string; token: string }>('artifact_preview_html', { html: s.html }).then(done, fail);
		} else if (m) {
			const ver = m.versions.find((x) => x.version === v);
			if (!ver) return;
			untrack(() => artifacts.pageFor(r.root, r.id, v, ver.format, m.title))
				.then((html) => invoke<{ url: string; token: string }>('artifact_preview', { root: r.root, id: r.id, version: v, html }))
				.then(done, fail);
		}
		return () => {
			stale = true;
			if (token) void invoke('artifact_preview_close', { token });
		};
	});

	// Link clicks inside the page (Rust's injected click guard): only from this frame, only web links.
	function onMessage(e: MessageEvent) {
		if (!frame || e.source !== frame.contentWindow) return;
		const href = linkToOpen(e.data);
		if (href) void invoke('terminal_open_url', { url: href, allowed: null });
	}

	async function act(f: () => Promise<unknown>) {
		busy = true;
		try {
			await f();
		} finally {
			busy = false;
		}
	}

	const when = (ms: number | string) => new Date(ms).toLocaleString(locale() === 'th' ? 'th-TH' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
	const title = $derived(meta?.title ?? shared?.title ?? '');
	const description = $derived(meta?.description ?? shared?.description ?? null);
	const MUTED = 'text-(--vscode-descriptionForeground)';
	const BTN = 'flex h-7 items-center gap-1.5 rounded-md border border-(--vscode-widget-border) px-2.5 text-[12px] hover:bg-(--vscode-list-hoverBackground) disabled:opacity-50';
</script>

<svelte:window onmessage={onMessage} />

<div class="flex h-full flex-col bg-(--vscode-editor-background)">
	{#if !ref}
		<p class="p-6 {MUTED}">{t('artifacts.badKey')}</p>
	{:else}
		<header class="flex shrink-0 flex-wrap items-start gap-2 border-b border-(--vscode-widget-border) px-4 py-2.5">
			<div class="min-w-0 flex-1">
				<h1 class="truncate text-[14px] font-semibold" title={title}>{title || t('artifacts.loading')}</h1>
				<p class="mt-0.5 truncate text-xs {MUTED}">
					{#if ref.team && shared}
						{t('artifacts.sharedBy', { user: shared.shared_by, when: when(shared.updated_at) })} · v{shared.version} · {formatSize(shared.size_bytes)} · {t('artifacts.readOnly')}
					{:else if current}
						{[current.format === 'markdown' ? 'Markdown' : 'HTML', when(current.created_at), formatSize(versionSize(current)), current.source === 'agent' ? t('artifacts.byAgent') : t('artifacts.byCli')].join(' · ')}
						{#if meta?.shared}· {t('artifacts.sharedVersion', { version: meta.shared.version })}{/if}
					{/if}
				</p>
				{#if description}<p class="mt-0.5 line-clamp-2 text-xs {MUTED}">{description}</p>{/if}
			</div>
			<div class="flex shrink-0 flex-wrap items-center gap-1.5">
				{#if meta && meta.versions.length > 1}
					<label class="flex items-center gap-1 text-xs {MUTED}">
						{t('artifacts.version')}
						<select class="h-7 rounded-md border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1 text-(--vscode-dropdown-foreground)" bind:value={version}>
							{#each [...meta.versions].reverse() as v (v.version)}<option value={v.version}>v{v.version} · {when(v.created_at)}</option>{/each}
						</select>
					</label>
				{/if}
				<button class={BTN} title={t('artifacts.reload')} aria-label={t('artifacts.reload')} onclick={() => reloads++}><Icon name="refresh" size={14} /></button>
				{#if !ref.team && meta && version !== null}
					{@const m = meta}
					{@const v = version}
					<button class={BTN} disabled={busy} onclick={() => act(() => artifacts.exportVersion(ref.root, m, v))}><Icon name="publish" size={14} />{t('artifacts.export')}</button>
					<button class={BTN} disabled={busy} title={artifacts.teamReady ? '' : t('artifacts.shareNeedsTeam')} onclick={() => act(() => artifacts.share(ref.root, m, v))}><Icon name="sync" size={14} />{t('artifacts.share')}</button>
					<button class={BTN} disabled={busy} title={t('artifacts.delete')} aria-label={t('artifacts.delete')} onclick={() => act(() => artifacts.remove(ref.root, m))}><Icon name="trash" size={14} /></button>
				{/if}
			</div>
		</header>
		<div class="relative min-h-0 flex-1">
			{#if error}
				<div class="space-y-2 p-6">
					<p role="alert" class="text-[13px] text-(--vscode-errorForeground)">{t('artifacts.previewFailed', { error })}</p>
				</div>
			{:else if url}
				{#key url}
					<!-- Untrusted page: scripts only, opaque origin (see PREVIEW_SANDBOX); the white canvas is the page's own default. -->
					<iframe bind:this={frame} src={url} title={title} sandbox={PREVIEW_SANDBOX} allow={PREVIEW_ALLOW} referrerpolicy="no-referrer" class="absolute inset-0 size-full border-0 bg-white"></iframe>
				{/key}
			{:else}
				<p class="p-6 text-[13px] {MUTED}">{t('artifacts.loading')}</p>
			{/if}
		</div>
	{/if}
</div>
