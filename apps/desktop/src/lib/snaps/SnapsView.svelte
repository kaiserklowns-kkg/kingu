<script lang="ts">
	// Snap management in the system settings page: every snap (user and this folder's repo snaps)
	// with what it declares, so a repo snap can be reviewed before it is trusted. Untrusted or
	// broken snaps are listed but contribute no tasks and no MCP servers.
	import Icon from '#lib/workbench/Icon.svelte';
	import { workspace } from '#lib/workbench/workspace.svelte.ts';
	import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
	import { isActive, settingId, settingsGroup, type SnapInfo } from './snapModel.ts';
	import { snaps } from './snaps.svelte.ts';

	let reloading = $state(false);

	async function reload() {
		reloading = true;
		await snaps.load();
		reloading = false;
	}

	function snapState(s: SnapInfo): { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
		if (s.error) return { label: 'ใช้งานไม่ได้ (Error)', tone: 'error' };
		if (s.overridden) return { label: 'ถูกแทนด้วย snap ของโฟลเดอร์ (Overridden)', tone: 'muted' };
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

		{#each snaps.list as s (s.source + '/' + s.id)}
			{@const st = snapState(s)}
			{@const active = isActive(s)}
			<section class="mt-4 rounded-md border border-(--vscode-widget-border,var(--vscode-panel-border)) p-3 text-[13px]" aria-label={`Snap ${s.name}`}>
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-semibold">{s.name}</span>
					{#if s.version}<span class="text-(--vscode-descriptionForeground)">v{s.version}</span>{/if}
					<span class={BADGE} title={s.source === 'user' ? 'Snap ของคุณ (user)' : 'Snap ของโฟลเดอร์นี้ แชร์ผ่าน git (repo)'}>{s.source}</span>
					<span class={['text-xs', TONE[st.tone]]}>{st.label}</span>
					<span class="flex-1"></span>
					{#if s.source === 'repo' && !s.error}
						{#if s.trusted}
							<button class={SECONDARY} onclick={() => snaps.trust(s.id, false)}>เลิกเชื่อถือ (Untrust)</button>
						{:else}
							<button class={BUTTON} onclick={() => snaps.trust(s.id, true)}>เชื่อถือ (Trust)</button>
						{/if}
					{/if}
				</div>
				<div class="mt-0.5 truncate text-[11px] text-(--vscode-descriptionForeground) opacity-80" title={s.dir}>{s.id} · {s.dir}</div>
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
					<div class="mt-3 grid gap-3 sm:grid-cols-2">
						<div>
							<div class={LABEL}>สิทธิ์ที่ขอ (Permissions)</div>
							<ul class="mt-1 space-y-0.5 text-(--vscode-descriptionForeground)">
								<li>เครือข่าย (network): {s.permissions.network ? 'ใช้' : 'ไม่ใช้'}</li>
								<li>ไฟล์ (fs): {s.permissions.fs === 'home' ? 'home — ทั้งโฮมโฟลเดอร์' : 'worktree — เฉพาะโฟลเดอร์งาน'}</li>
								<li>Secrets: {s.permissions.secrets.length ? s.permissions.secrets.join(', ') : '—'}</li>
							</ul>
							<p class="mt-1 text-[11px] text-(--vscode-descriptionForeground) opacity-80">ประกาศไว้ให้ตรวจเท่านั้น ยังไม่ได้บังคับใช้ (not enforced yet)</p>
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
			<p class="mt-6 text-(--vscode-descriptionForeground)">{snaps.loaded ? 'ยังไม่มี Snap — สร้างโฟลเดอร์ที่มี snap.toml ในโฟลเดอร์ snaps ของแอป หรือใน .kingu/snaps ของโฟลเดอร์งาน' : 'กำลังโหลด…'}</p>
		{/each}
	</div>
</div>
