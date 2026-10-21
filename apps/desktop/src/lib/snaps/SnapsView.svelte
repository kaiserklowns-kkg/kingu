<script lang="ts">
	// Snap management in the system settings page: every snap (user and this folder's repo snaps)
	// with what it declares, so a repo snap can be reviewed before it is trusted. Untrusted or
	// broken snaps are listed but contribute no tasks and no MCP servers. With
	// `systemSettings.snapKey` set it is one snap's details page (a row of the Snaps side view).
	import Icon from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { enforcementLabel, isActive, isUpdatable, lockNote, originLabel, SANDBOX_SETTING, settingId, settingsGroup, snapKey, type SnapInfo } from './snapModel.ts';
	import { snaps } from './snaps.svelte.ts';
	import { contributionGroups, contributionsOf, type ContributionKind } from './contributions.ts';
	import { t } from '#lib/i18n/index.ts';

	let reloading = $state(false);
	const shown = $derived(systemSettings.snapKey ? snaps.all.filter((s) => snapKey(s) === systemSettings.snapKey) : snaps.all);
	/** The kinds the overview chips name; the new contribution kinds also get a section below. */
	const KIND_KEYS: Record<ContributionKind, `snapContrib.kind.${ContributionKind}`> = {
		languages: 'snapContrib.kind.languages',
		grammars: 'snapContrib.kind.grammars',
		snippets: 'snapContrib.kind.snippets',
		lsp: 'snapContrib.kind.lsp',
		themes: 'snapContrib.kind.themes',
		iconThemes: 'snapContrib.kind.iconThemes',
		views: 'snapContrib.kind.views',
		commands: 'snapContrib.kind.commands',
		settings: 'snapContrib.kind.settings',
		mcp: 'snapContrib.kind.mcp',
		skills: 'snapContrib.kind.skills'
	};
	const DETAILED: ContributionKind[] = ['languages', 'grammars', 'snippets', 'lsp', 'themes', 'iconThemes', 'views'];
	const enforcement = $derived(enforcementLabel(snaps.sandbox));

	async function reload() {
		reloading = true;
		await snaps.load();
		reloading = false;
	}

	function snapState(s: SnapInfo): { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
		if (s.error) return { label: 'ใช้งานไม่ได้ (Error)', tone: 'error' };
		if (s.overridden) return { label: s.source === 'builtin' ? t('snapContrib.builtinOverridden') : 'ถูกแทนด้วย snap ของโฟลเดอร์ (Overridden)', tone: 'muted' };
		if (!s.trusted) return { label: 'ยังไม่เชื่อถือ (Untrusted)', tone: 'warn' };
		return { label: 'ใช้งานอยู่ (Active)', tone: 'ok' };
	}

	const TONE = {
		ok: 'text-(--vscode-testing-iconPassed,var(--vscode-charts-green))',
		warn: 'text-(--vscode-editorWarning-foreground)',
		error: 'text-(--vscode-errorForeground)',
		muted: 'text-(--vscode-descriptionForeground)'
	};
	const BADGE = 'rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 text-(--vscode-badge-foreground)';
	const BUTTON = 'rounded-md bg-(--vscode-button-background) px-2.5 py-0.5 text-[13px] text-(--vscode-button-foreground) hover:brightness-110';
	const SECONDARY = 'rounded-md bg-(--vscode-button-secondaryBackground) px-2.5 py-0.5 text-[13px] text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)';
	const LABEL = 'text-[11px] font-semibold tracking-wide text-(--vscode-descriptionForeground) uppercase';
</script>

<div class="h-full overflow-y-auto bg-(--vscode-editor-background) text-(--vscode-foreground)">
	<div class="mx-auto w-full max-w-[1000px] px-6 pt-3 pb-8">
		<div class="flex items-center gap-2">
			<h2 class="text-lg font-semibold text-(--vscode-settings-headerForeground)">Snaps</h2>
			{#if systemSettings.snapKey}
				<button class="text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => (systemSettings.snapKey = null)}>ดูทั้งหมด (All snaps)</button>
			{/if}
			<span class="flex-1"></span>
			<button class={[SECONDARY, 'flex items-center gap-1.5']} disabled={reloading} onclick={reload}><Icon name="refresh" size={14} /> โหลดใหม่ (Reload)</button>
		</div>
		<p class="mt-1 text-[13px] text-(--vscode-descriptionForeground)">
			Snap คือแพ็กของงาน การตั้งค่า MCP server และ skill ที่ใช้ได้ทั้งใน IDE และ ADE — ของคุณเองอยู่ในโฟลเดอร์ config ของแอป (<code>snaps/&lt;id&gt;/snap.toml</code>), ของโฟลเดอร์งานอยู่ใน
			<code>.kingu/snaps/&lt;id&gt;/snap.toml</code> และต้องกดเชื่อถือก่อนจึงจะรันได้
		</p>
		{#if snaps.error}
			<p role="alert" class="mt-3 rounded-md border border-(--vscode-editorError-foreground) px-2 py-1 text-xs text-(--vscode-errorForeground)">โหลด Snaps ไม่สำเร็จ: {snaps.error}</p>
		{/if}

		{#if snaps.sandbox.kind === 'off'}
			<p role="alert" class="mt-3 flex items-start gap-1.5 rounded-md border border-(--vscode-editorWarning-foreground) px-2 py-1.5 text-xs text-(--vscode-editorWarning-foreground)">
				<Icon name="warning" size={14} />
				<span>ปิดการบังคับสิทธิ์ของ Snap อยู่ (<code>{SANDBOX_SETTING}</code> = "off") งานและ MCP server ของทุก snap รันได้ทุกอย่างที่คุณทำได้ รวมถึงเห็น token ใน environment</span>
				<button class="ml-auto shrink-0 text-(--vscode-textLink-foreground) hover:underline" onclick={() => systemSettings.show('Snap Sandbox')}>ตั้งค่า</button>
			</p>
		{/if}

		{#if snaps.busy}<p class="mt-3 text-xs text-(--vscode-descriptionForeground)">{snaps.busy}</p>{/if}

		{#each shown as s (snapKey(s))}
			{@const st = snapState(s)}
			{@const active = isActive(s)}
			<section class="mt-4 rounded-md border border-(--vscode-widget-border,var(--vscode-panel-border)) p-3 text-[13px]" aria-label={`Snap ${s.name}`}>
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-semibold">{s.name}</span>
					{#if s.version}<span class="text-(--vscode-descriptionForeground)">v{s.version}</span>{/if}
					<span class={BADGE} title={s.source === 'user' ? 'Snap ของคุณ (user)' : s.source === 'builtin' ? t('snapContrib.builtinTitle') : 'Snap ของโฟลเดอร์นี้ แชร์ผ่าน git (repo)'}>{s.source}</span>
					<span class={['text-xs', TONE[st.tone]]}>{st.label}</span>
					{#if lockNote(s)}<span class="text-xs text-(--vscode-editorWarning-foreground)" title=".kingu/snaps.lock">{lockNote(s)}</span>{/if}
					<span class="flex-1"></span>
					{#if isUpdatable(s)}<button class={SECONDARY} disabled={!!snaps.busy} onclick={() => snaps.update(s.id)}>อัปเดต (Update)</button>{/if}
					{#if s.source === 'user'}
						{#if !s.error}<button class={SECONDARY} onclick={() => snaps.editManifest(s)}>แก้ snap.toml</button>{/if}
						<button class={SECONDARY} disabled={!!snaps.busy} onclick={() => snaps.uninstall(s.id)}>ถอนการติดตั้ง (Uninstall)</button>
					{/if}
					{#if s.source !== 'builtin'}<button class={SECONDARY} onclick={() => snaps.reveal(s)}>เปิดโฟลเดอร์ (Reveal)</button>{/if}
					{#if s.source === 'repo' && !s.error}
						{#if s.trusted}
							<button class={SECONDARY} onclick={() => snaps.trust(s.id, false)}>เลิกเชื่อถือ (Untrust)</button>
						{:else}
							<button class={BUTTON} onclick={() => snaps.trust(s.id, true)}>เชื่อถือ (Trust)</button>
						{/if}
					{/if}
				</div>
				<div class="mt-0.5 truncate text-[11px] text-(--vscode-descriptionForeground) opacity-80" title={s.dir}>{s.id} · {s.source === 'builtin' ? t('snapContrib.builtinTitle') : s.dir}</div>
				{#if s.origin}
					<div class="mt-0.5 truncate text-[11px] text-(--vscode-descriptionForeground) opacity-80" title={originLabel(s.origin)}>
						ติดตั้งจาก {originLabel(s.origin)}{s.origin.installed_at ? ` · ${new Date(s.origin.installed_at * 1000).toLocaleString()}` : ''}
					</div>
				{/if}
				{#if s.description}<p class="mt-1 text-(--vscode-descriptionForeground)">{s.description}</p>{/if}
				{#if s.error}
					<p role="alert" class="mt-2 flex items-start gap-1.5 text-(--vscode-errorForeground)"><Icon name="error" size={14} /> <span>{s.error}</span></p>
				{/if}
				{#if s.source === 'repo' && !s.error && !s.trusted}
					<p class="mt-2 flex items-start gap-1.5 rounded-md border border-(--vscode-editorWarning-foreground) px-2 py-1.5 text-(--vscode-editorWarning-foreground)">
						<Icon name="warning" size={14} />
						<span
							>Snap นี้มาจากโฟลเดอร์ที่เปิดอยู่ (<code>.kingu/snaps</code>) ใครก็ตามที่แก้ repo นี้เขียนได้ — การเชื่อถือจะให้ snap นี้รันคำสั่งในโฟลเดอร์นี้และ worktree ของงาน และส่ง MCP server กับ skill ให้ agent ได้
							ตรวจคำสั่งและสิทธิ์ด้านล่างก่อนกดเชื่อถือ ถ้า snap.toml หรือไฟล์ของ skill เปลี่ยน Kingu จะเลิกเชื่อถือให้อัตโนมัติ</span
						>
					</p>
				{/if}

				{#if !s.error}
					{@const groups = contributionGroups(s)}
					<!-- What the snap adds, by kind (VS Code's extension page "Feature Contributions"). -->
					<div class={['mt-3', LABEL]}>{t('snapContrib.details.title')}</div>
					<div class="mt-1 flex flex-wrap gap-1.5" aria-label={t('snapContrib.details.title')}>
						{#each groups as g (g.kind)}
							<span class="rounded-md border border-(--vscode-widget-border) px-1.5 py-0.5 text-[12px]">{t(KIND_KEYS[g.kind])} <span class="text-(--vscode-descriptionForeground)">{g.items.length}</span></span>
						{:else}
							<span class="text-(--vscode-descriptionForeground)">—</span>
						{/each}
					</div>
					{#each groups.filter((g) => DETAILED.includes(g.kind)) as g (g.kind)}
						<div class={['mt-3', LABEL]}>{t(KIND_KEYS[g.kind])}</div>
						{#each g.items as item, i (i)}
							<div class="mt-1"><span class="font-semibold">{item.label}</span> {#if item.detail}<code class="text-(--vscode-descriptionForeground)">{item.detail}</code>{/if}</div>
						{/each}
						{#if g.kind === 'views' && !active}
							<p class="mt-1 text-[11px] text-(--vscode-descriptionForeground) opacity-80">{t('snapContrib.details.viewsInactive')}</p>
						{/if}
						{#if g.kind === 'lsp' && s.source === 'repo'}
							<p class="mt-1 text-[11px] text-(--vscode-descriptionForeground) opacity-80">{t('snapContrib.details.lspRepo')}</p>
						{/if}
					{/each}
					{#if contributionsOf(s).views.length}
						<p class="mt-1 text-[11px] text-(--vscode-descriptionForeground) opacity-80">{t('snapContrib.details.viewsSandbox')}</p>
					{/if}

					<div class="mt-3 grid gap-3 sm:grid-cols-2">
						<div>
							<div class={LABEL}>สิทธิ์ที่ขอ (Permissions)</div>
							<ul class="mt-1 space-y-0.5 text-(--vscode-descriptionForeground)">
								<li>เครือข่าย (network): {s.permissions.network ? 'ใช้' : 'ไม่ใช้'}</li>
								<li>ไฟล์ (fs): {s.permissions.fs === 'home' ? 'home — ทั้งโฮมโฟลเดอร์' : 'worktree — เฉพาะโฟลเดอร์งาน'}</li>
								<li>Secrets: {s.permissions.secrets.length ? s.permissions.secrets.join(', ') : '—'}</li>
							</ul>
							<p class={['mt-1 text-[11px]', TONE[enforcement.tone]]} title="งานและ MCP server ของ snap รันผ่าน kingu-ptyd snap-exec: เขียนไฟล์ได้เฉพาะที่ประกาศ อ่านได้ทั้งเครื่อง ไม่เห็น secret ที่ไม่ได้ประกาศ">
								{enforcement.text}
							</p>
						</div>
						<div>
							<div class={LABEL}>MCP servers</div>
							{#each s.mcp as m (m.name)}
								<div class="mt-1"><span class="font-semibold">{m.name}</span> <code class="text-(--vscode-descriptionForeground)">{m.command.join(' ')}</code></div>
								{#if Object.keys(m.env).length}<div class="text-[11px] text-(--vscode-descriptionForeground)">env: {Object.entries(m.env).map(([k, v]) => `${k}=${v}`).join(' ')}</div>{/if}
							{:else}
								<div class="mt-1 text-(--vscode-descriptionForeground)">—</div>
							{/each}
						</div>
					</div>

					<div class={['mt-3', LABEL]}>Skills (ให้ agent)</div>
					{#each s.skills as k (k.path)}
						<div class="mt-1">
							<span class="font-semibold">{k.name}</span> <code class="text-(--vscode-descriptionForeground)">{k.path}/SKILL.md</code>
							{#if k.description}<span class="text-(--vscode-descriptionForeground)"> — {k.description}</span>{/if}
						</div>
					{:else}
						<div class="mt-1 text-(--vscode-descriptionForeground)">—</div>
					{/each}
					{#if s.skills.length}
						<p class="mt-1 text-[11px] text-(--vscode-descriptionForeground) opacity-80">
							agent แบบ timeline และ claude CLI ได้ skill เหล่านี้ในชื่อ <code>snap-{s.id}:&lt;skill&gt;</code>{active ? '' : ' เมื่อ snap นี้ใช้งานอยู่'} — codex และ CLI อื่นยังไม่ได้
						</p>
					{/if}

					<div class={['mt-3', LABEL]}>งาน (Tasks)</div>
					{#each s.tasks as t (t.id)}
						<div class="mt-1 flex items-center gap-2">
							<span class="min-w-0 flex-1"><span>{t.title}</span> <code class="text-(--vscode-descriptionForeground)">{t.command.join(' ')}</code></span>
							<button
								class={[active ? BUTTON : SECONDARY, 'flex shrink-0 items-center gap-1 disabled:opacity-50']}
								disabled={!active || !workspace.root}
								title={!active ? 'เชื่อถือ snap นี้ก่อนจึงจะรันได้' : !workspace.root ? 'เปิดโฟลเดอร์ก่อน' : 'รันในเทอร์มินัลใหม่ (IDE: แผง Terminal, ADE: worktree ที่เลือก)'}
								onclick={() => snaps.runTask(s.id, t.id)}><Icon name="play" size={12} /> รัน (Run)</button
							>
						</div>
					{:else}
						<div class="mt-1 text-(--vscode-descriptionForeground)">—</div>
					{/each}

					<div class={['mt-3', LABEL]}>การตั้งค่า (Settings)</div>
					{#each s.settings as st (st.key)}
						<div class="mt-1"><code>{settingId(s.id, st.key)}</code> <span class="text-(--vscode-descriptionForeground)">({st.type}, ค่าเริ่มต้น {JSON.stringify(st.default)}) {st.description}</span></div>
					{:else}
						<div class="mt-1 text-(--vscode-descriptionForeground)">—</div>
					{/each}
					{#if s.settings.length && !s.overridden}
						<button class="mt-1 text-xs text-(--vscode-textLink-foreground) hover:underline" onclick={() => systemSettings.show(settingsGroup(s))}>แก้การตั้งค่า (Edit settings)</button>
					{/if}
				{/if}
			</section>
		{:else}
			<p class="mt-6 text-(--vscode-descriptionForeground)">{systemSettings.snapKey && snaps.loaded ? 'ไม่พบ Snap นี้แล้ว' : snaps.loaded ? 'ยังไม่มี Snap — สร้างโฟลเดอร์ที่มี snap.toml ในโฟลเดอร์ snaps ของแอป หรือใน .kingu/snaps ของโฟลเดอร์งาน' : 'กำลังโหลด…'}</p>
		{/each}
	</div>
</div>
