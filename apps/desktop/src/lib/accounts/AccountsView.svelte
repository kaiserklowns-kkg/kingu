<script lang="ts">
	// Manage Accounts (in the system settings page): per provider, the user's own login and the
	// accounts added in Kingu; which one agents use; login / API key / remove; usage and its history.
	// API keys are typed into a password field and go straight to Rust (Keychain); never kept here.
	import Icon, { type IconName } from '#lib/workbench/Icon.svelte';
	import { accounts } from './accounts.svelte';
	import { pct, percentLine, PROVIDER_TITLE, PROVIDERS, resetLabel, updatedAgo, windows, windowTitle, type AccountView, type Provider, type Sample } from './usage';

	const ICON: Record<Provider, IconName> = { claude: 'claude', codex: 'openai' };
	const OWN_DIR: Record<Provider, string> = { claude: '~/.claude', codex: '~/.codex' };

	let key = $state('');
	let keyError = $state('');
	let saving = $state(false);
	let history = $state<Record<string, Sample[]>>({});

	$effect(() => {
		void accounts.load();
		return accounts.start();
	});

	// History of every subject with numbers (loaded when the rows change).
	$effect(() => {
		const keys = accounts.rows.filter((r) => r.usage).map((r) => r.key);
		void Promise.all(keys.map(async (k) => [k, await accounts.history(k)] as const)).then((pairs) => (history = Object.fromEntries(pairs)));
	});

	const list = (p: Provider) => accounts.view?.accounts.filter((a) => a.provider === p) ?? [];
	const hasActive = (p: Provider) => list(p).some((a) => a.active);
	function ownText(p: Provider): string | null {
		const own = accounts.view?.own[p];
		return own?.signed_in ? (own.email ?? 'login แล้ว') + (own.org ? ` · ${own.org}` : '') : null;
	}
	const rowOf = (p: Provider, id: string | null) => accounts.rows.find((r) => r.provider === p && r.account_id === id);

	function stateText(a: AccountView): string {
		if (a.kind === 'api_key') return a.signed_in ? 'มี API key ใน Keychain' : 'ยังไม่ได้ตั้ง API key';
		if (accounts.loggingIn.includes(a.id)) return 'กำลังรอ login ใน terminal…';
		return a.signed_in ? (a.email ?? 'login แล้ว') + (a.org ? ` · ${a.org}` : '') : 'ยังไม่ได้ login';
	}

	function editKey(id: string) {
		accounts.editingKey = accounts.editingKey === id ? null : id;
		key = '';
		keyError = '';
	}

	async function saveKey(e: SubmitEvent, id: string) {
		e.preventDefault();
		saving = true;
		keyError = (await accounts.setKey(id, key)) ?? '';
		key = '';
		saving = false;
	}

	const BTN = 'h-6 rounded-md px-2 text-xs hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const PRIMARY = 'h-6 rounded-md bg-(--vscode-button-background) px-2 text-xs text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-50';
	const ROW = 'flex items-center gap-3 rounded-md px-3 py-2 hover:bg-(--vscode-list-hoverBackground)';
</script>

{#snippet usageLine(p: Provider, id: string | null)}
	{@const r = rowOf(p, id)}
	{#if r && (r.usage || r.error)}
		{@const samples = history[r.key] ?? []}
		<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-(--vscode-descriptionForeground)">
			{#each windows(r.usage) as w (w.name)}
				<span class="tabular-nums">{windowTitle(w.name)} {pct(w.window.used_percent)}% · รีเซ็ตใน {resetLabel(w.window, accounts.now)}</span>
			{/each}
			{#if r.usage?.plan}<span>แพ็กเกจ {r.usage.plan}</span>{/if}
			{#if r.updated_at}<span>{updatedAgo(r.updated_at, accounts.now)}</span>{/if}
			{#if r.error}<span class="text-(--vscode-editorWarning-foreground)">{r.error}</span>{/if}
		</div>
		{#if samples.length > 1}
			<div class="mt-1 flex items-center gap-2 text-[11px] text-(--vscode-descriptionForeground)" title="ประวัติ usage ({samples.length} ครั้ง)">
				<svg width="160" height="20" aria-hidden="true">
					<polyline points={percentLine(samples.map((s) => s.weekly ?? 0), 160, 20)} fill="none" stroke="var(--vscode-textLink-foreground)" stroke-width="1.25" />
					<polyline points={percentLine(samples.map((s) => s.session ?? 0), 160, 20)} fill="none" stroke="var(--vscode-descriptionForeground)" stroke-width="1" stroke-dasharray="2 2" />
				</svg>
				<span>— 7 วัน · - - 5 ชั่วโมง</span>
			</div>
		{/if}
	{/if}
{/snippet}

<div class="h-full overflow-y-auto px-6 py-4 text-[13px]">
	<div class="max-w-3xl space-y-6">
		<p class="text-(--vscode-descriptionForeground)">
			บัญชีที่ agent ใช้ (ทั้งแบบ CLI ใน terminal และแบบ timeline) เลือกได้ทีละบัญชีต่อผู้ให้บริการ บัญชี subscription login ผ่าน CLI ของผู้ให้บริการใน terminal ของ Kingu และเก็บ
			login ไว้ในโฟลเดอร์ของบัญชีนั้น ส่วน API key เก็บใน macOS Keychain เท่านั้น ประวัติ session และการตั้งค่าส่วนตัวใช้ร่วมกับ <code>~/.claude</code>
		</p>
		{#each PROVIDERS as p (p)}
			<section aria-label={PROVIDER_TITLE[p]}>
				<div class="mb-1 flex items-center gap-2">
					<Icon name={ICON[p]} size={16} />
					<h2 class="flex-1 font-semibold">{PROVIDER_TITLE[p]}</h2>
					<button class={BTN} onclick={() => accounts.add(p, 'subscription')}><span class="inline-flex items-center gap-1"><Icon name="plus" size={12} />{p === 'claude' ? 'Claude subscription' : 'ChatGPT login'}</span></button>
					<button class={BTN} onclick={() => accounts.add(p, 'api_key')}><span class="inline-flex items-center gap-1"><Icon name="key" size={12} />API key</span></button>
				</div>
				<div role="radiogroup" aria-label="บัญชีที่ agent {PROVIDER_TITLE[p]} ใช้" class="space-y-0.5">
					<div class={ROW}>
						<input type="radio" name="active-{p}" checked={!hasActive(p)} aria-label="ใช้บัญชีของคุณเอง" onchange={() => accounts.setActive(p, null)} />
						<div class="min-w-0 flex-1">
							<div>บัญชีของคุณเอง <span class="text-xs text-(--vscode-descriptionForeground)">({OWN_DIR[p]})</span></div>
							<div class="text-xs text-(--vscode-descriptionForeground)">
								{ownText(p) ?? `ยังไม่ได้ login (รัน ${p === 'claude' ? 'claude' : 'codex login'} เองใน terminal ก็ได้)`}
							</div>
							{@render usageLine(p, null)}
						</div>
					</div>
					{#each list(p) as a (a.id)}
						<div class={ROW}>
							<input type="radio" name="active-{p}" checked={a.active} disabled={!a.signed_in} aria-label="ใช้บัญชี {a.label}" onchange={() => accounts.setActive(p, a.id)} />
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="truncate">{a.label}</span>
									<span class="rounded-sm border border-(--vscode-widget-border) px-1 text-[10px] text-(--vscode-descriptionForeground) uppercase">{a.kind === 'api_key' ? 'API key' : 'subscription'}</span>
								</div>
								<div class={['text-xs', a.signed_in ? 'text-(--vscode-descriptionForeground)' : 'text-(--vscode-editorWarning-foreground)']}>{stateText(a)}</div>
								{@render usageLine(p, a.id)}
								{#if accounts.editingKey === a.id}
									<form class="mt-2 flex items-start gap-2" onsubmit={(e) => saveKey(e, a.id)}>
										<div class="flex flex-1 flex-col gap-1">
											<input
												type="password"
												bind:value={key}
												autocomplete="off"
												spellcheck="false"
												placeholder={p === 'claude' ? 'sk-ant-…' : 'sk-…'}
												aria-label="API key"
												aria-invalid={keyError ? 'true' : undefined}
												class="h-[26px] rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 font-mono text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)"
											/>
											{#if keyError}<span role="alert" class="text-xs text-(--vscode-errorForeground)">{keyError}</span>{/if}
										</div>
										<button type="submit" class={PRIMARY} disabled={saving || !key.trim()}>บันทึกลง Keychain</button>
										<button type="button" class={BTN} onclick={() => editKey(a.id)}>ยกเลิก</button>
									</form>
								{/if}
							</div>
							{#if a.kind === 'subscription'}
								<button class={BTN} disabled={accounts.loggingIn.includes(a.id)} onclick={() => accounts.login(a.id)}>{a.signed_in ? 'Login ใหม่' : 'Login'}</button>
							{:else}
								<button class={BTN} onclick={() => editKey(a.id)}>{a.signed_in ? 'เปลี่ยน key' : 'ตั้ง API key'}</button>
							{/if}
							<button class={BTN} aria-label="ลบบัญชี {a.label}" title="ลบบัญชี" onclick={() => accounts.remove(a.id)}><Icon name="trash" size={13} /></button>
						</div>
					{/each}
				</div>
			</section>
		{/each}
	</div>
</div>
