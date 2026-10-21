<script lang="ts">
	// Kingu Home: the empty editor area (kingu-old's kinguHome.ts in VS Code's editor group
	// watermark). Under the letterpress logo, the agent chats to continue across every recent
	// folder (kingu.home.enabled), the recent projects, then the watermark's shortcuts
	// (workbench.tips.enabled) with their live keys. Choosing logic is in home.ts.
	import { tick } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import Codicon from './Codicon.svelte';
	import { KINGU_GLYPH, KINGU_GLYPH_BOX } from './KinguMark.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { timeAgo } from '#lib/ade/model.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { workspace } from './workspace.svelte.ts';
	import { commands, keyOf } from './commands.svelte.ts';
	import { notifications } from './notifications.svelte.ts';
	import { isMac, keyParts } from './keys.ts';
	import { chats } from '#lib/agent/chats.svelte.ts';
	import { chatHistory, STATUS_KEY } from '#lib/agent/chatHistory.svelte.ts';
	import { openChat } from '#lib/agent/chatCommands.svelte.ts';
	import { runtimeOf } from '#lib/agent/runtimes.ts';
	import { homeChats, MAX_HOME_PROJECTS, OTHER_ENTRIES, shuffled, watermarkEntries, type HomeChatRow, type SavedHomeChat } from './home.ts';

	/** False in a group too short for them (VS Code: under 478px). */
	let { shortcuts: showShortcuts = true }: { shortcuts?: boolean } = $props();

	const homeOn = $derived(settings.get<boolean>('kingu.home.enabled') !== false);
	const tipsOn = $derived(showShortcuts && settings.get<boolean>('workbench.tips.enabled') !== false);

	// The other recent folders' chats, as saved (Rust reads only folders from recent.json).
	let saved = $state<SavedHomeChat[]>([]);
	$effect(() => {
		if (!homeOn) return;
		void workspace.root;
		void workspace.recent.length;
		let stale = false;
		invoke<SavedHomeChat[]>('home_recent_chats')
			.then((list) => !stale && (saved = list))
			.catch(() => !stale && (saved = []));
		return () => (stale = true);
	});

	// Relative times stay current.
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	const rows = $derived.by(() => {
		// The open folder's chats live (status of a running turn) once its list is loaded; until
		// then, as saved like the others.
		const live = chats.root === workspace.root && chats.loaded;
		const liveRows = live
			? chats.visible.map((c) => ({ id: c.id, title: c.title, agentName: c.agent ?? chatHistory.runtimeName(runtimeOf(c)), at: c.updated_at || c.created_at, status: chatHistory.statusOf(c.id) }))
			: [];
		return homeChats(live ? workspace.root : null, liveRows, saved, (id) => chatHistory.runtimeName(id));
	});
	const projects = $derived(workspace.recentFolders().slice(0, MAX_HOME_PROJECTS));

	// With a folder, VS Code fills the shortcuts up to three from a shuffled list, once per watermark.
	const other = shuffled(OTHER_ENTRIES);
	const shortcuts = $derived(
		tipsOn
			? watermarkEntries(!!workspace.root, isMac, (id) => {
					const cmd = commands.get(id);
					return cmd && keyOf(cmd);
				}, other)
			: []
	);

	/** A chat of another folder opens that folder in this window first (as Open Recent would). */
	async function continueChat(row: HomeChatRow) {
		try {
			if (row.root !== workspace.root) {
				if (!(await workspace.openFolder(row.root))) return;
				// Opened in a new window, or brought the window that has it to the front.
				if (workspace.root !== row.root) return;
				if (chats.root !== row.root || !chats.loaded) await chats.load();
				await tick();
			}
			openChat(row.id);
		} catch (e) {
			notifications.error(t('home.openFailed', { error: String(e) }));
		}
	}

	// kingu-old's statusIcon (kinguHome.ts): loading~spin, report, error, comment-discussion; codicons
	// at their own 16px (the `.kingu-home-icon` 14px loses to `.codicon`), in the description colour.
	const STATUS_ICON = { working: 'loading~spin', needsInput: 'report', failed: 'error', idle: 'comment-discussion' } as const;
	const STATUS_COLOR = { working: '', needsInput: 'text-(--vscode-editorWarning-foreground)', failed: 'text-(--vscode-errorForeground)', idle: '' } as const;
	const ICON = 'shrink-0 text-(--vscode-descriptionForeground)';
</script>

<div class="flex w-full flex-col items-center gap-6 py-6">
	<!-- VS Code's `.letterpress`: a 256px box, the glyph (172 x 213) centred in it. -->
	<div class="grid size-[256px] max-w-full shrink-0 place-items-center" aria-hidden="true">
		<svg class="letterpress h-[213px] w-[172px] max-w-full text-(--vscode-foreground)" viewBox={KINGU_GLYPH_BOX}>
			<path fill="currentColor" fill-rule="evenodd" d={KINGU_GLYPH} />
		</svg>
	</div>

	{#if homeOn}
		<!-- kinguLook.css `.kingu-home`: margin 8px auto 20px inside the watermark's 24px gaps. -->
		<div class="mx-auto mt-2 mb-5 flex w-[min(440px,90%)] flex-col gap-[18px] text-left text-[13px]" role="region" aria-label={t('home.label')}>
			<section>
				<h2 class="mb-1 ml-2 text-[11px] font-normal tracking-[0.04em] text-(--vscode-descriptionForeground) uppercase">{t('home.continue')}</h2>
				{#each rows as row (row.root + '\n' + row.id)}
					{@const detail = t('home.chatDetail', { agent: row.agentName, when: timeAgo(row.at, now) })}
					<button class="row" title={`${row.title} — ${detail}`} onclick={() => continueChat(row)}>
						<span class={[ICON, 'flex', STATUS_COLOR[row.status]]} role={row.status === 'working' ? 'status' : undefined} title={t(STATUS_KEY[row.status])}><Codicon id={STATUS_ICON[row.status]} size={16} /></span>
						<span class="label">{row.title}</span>
						<span class="detail">{detail}</span>
					</button>
				{:else}
					<button class="row" onclick={() => commands.run('workbench.action.chat.open')}>
						<span class={[ICON, 'flex']}><Codicon id="comment-discussion" size={16} /></span>
						<span class="label">{t('home.startChat')}</span>
					</button>
				{/each}
			</section>
			<section>
				<h2 class="mb-1 ml-2 text-[11px] font-normal tracking-[0.04em] text-(--vscode-descriptionForeground) uppercase">{t('home.projects')}</h2>
				{#each projects as p (p.path)}
					<button class="row" title={`${p.label} — ${p.detail}`} onclick={() => workspace.openFolder(p.path)}>
						<span class={[ICON, 'flex']}><Codicon id="folder" size={16} /></span>
						<span class="label">{p.label}</span>
						<span class="detail">{p.detail}</span>
					</button>
				{/each}
				<button class="row" onclick={() => commands.run('workbench.action.files.openFolder')}>
					<span class={[ICON, 'flex']}><Codicon id="folder-opened" size={16} /></span>
					<span class="label">{t('home.openFolder')}</span>
				</button>
			</section>
		</div>
	{/if}

	{#if shortcuts.length}
		<!-- workbench.tips.enabled: VS Code's watermark shortcuts, one keycap per key. -->
		<div class="flex w-[272px] max-w-[90%] flex-col text-(--vscode-descriptionForeground)">
			{#each shortcuts as s (s.id)}
				<dl class="my-1 flex cursor-default items-center justify-between">
					<dt class="tracking-[0.04em]">{t(s.label)}</dt>
					<dd class="ms-6 flex items-center leading-[10px]">
						{#each keyParts(s.key, isMac) as chord, ci (ci)}
							{#if ci > 0}<span class="inline-block w-1.5"></span>{/if}
							<span class="flex items-center">
								{#each chord as k, ki (ki)}
									<kbd class="keycap">{k}</kbd>
								{/each}
							</span>
						{/each}
					</dd>
				</dl>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* kingu-old's letterpress: the glyph alone, faint (VS Code's letterpress opacity per theme). */
	.letterpress {
		opacity: 0.1;
	}
	:global(:root[data-theme-type='dark']) .letterpress {
		opacity: 0.2;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
		height: 26px;
		padding: 0 8px;
		border-radius: 6px;
		text-align: left;
		color: var(--vscode-foreground);
	}
	.row:hover {
		background-color: var(--vscode-list-hoverBackground);
	}
	.row:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: -1px;
	}
	.label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.detail {
		flex-shrink: 1;
		min-width: 0;
		margin-left: auto;
		padding-left: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--vscode-descriptionForeground);
	}
	/* VS Code's KeybindingLabel keys (defaultKeybindingLabelStyles). */
	.keycap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 12px;
		margin: 0 2px;
		padding: 3px 5px;
		border: 1px solid var(--vscode-keybindingLabel-border);
		border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
		border-radius: 3px;
		box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow);
		background-color: var(--vscode-keybindingLabel-background);
		color: var(--vscode-keybindingLabel-foreground);
		font-family: inherit;
		font-size: 11px;
		line-height: 10px;
	}
	.keycap:first-child {
		margin-left: 0;
	}
	.keycap:last-child {
		margin-right: 0;
	}
</style>
