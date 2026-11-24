<script lang="ts">
	// Quick reply for a terminal agent's question: while the task's CLI asks one (its hooks carried
	// the options), the question card types the chosen answer into that task's own CLI terminal.
	// A permission prompt (its hooks said so) gets Allow once / Deny, which answer the CLI's waiting
	// hook or press Enter (the highlighted first choice) / Esc in that terminal, like the phone does.
	// The card shows what is asked (the command or path, permissionAsk.ts). While the hook waits it
	// also offers "Allow for this session" when Claude suggested what that would grant (Orca's
	// `allowForSession`), listing exactly those grants, and takes a reason with a deny. Where Claude
	// suggested allow rules it also offers VS Code's wider scopes (runInTerminalHelpers.ts
	// `generateAutoApproveActions`: in this Session / in this Workspace / Always Allow), saved by
	// Claude itself through its `updatedPermissions` destinations (permission_rules.rs): "Always
	// allow in this project" (`localSettings`) and "Always allow" (`userSettings`), with the file
	// named and a warning when git would track it. Every grant is listed in Permission Grants.
	import QuestionCard from '#lib/agent/QuestionCard.svelte';
	import { status } from '#lib/workbench/status.svelte.ts';
	import { cliSessions } from './cliSessions.svelte';
	import { cliName } from './agentCli';
	import { t } from '#lib/i18n/index.ts';
	import { liveHold } from './agentHooks';
	import { grantKey, MAX_DENY_MESSAGE, scopedGrants, type Grant, type GrantScope } from './permissionAsk';
	import { permissionGrants } from './permissionGrants.svelte';
	import { BUTTON, BUTTON_SECONDARY, INPUT } from './ui';

	let { slug, class: klass = '' }: { slug: string; class?: string } = $props();

	const hook = $derived(cliSessions.hooks[slug]);
	const ask = $derived(hook?.phase === 'waiting' && hook.question ? hook.ask : undefined);
	/** Which question this is: a different one gets a fresh card (and shows again after "hide"). */
	const id = $derived(ask ? JSON.stringify(ask) : '');
	let hidden = $state('');
	const run = $derived(cliSessions.sessions[slug]?.run);
	const asking = $derived(hook?.phase === 'waiting' && hook.permission ? `${hook.at}:${hook.message ?? ''}` : '');
	const request = $derived(asking ? hook?.request : undefined);
	/** The CLI's hook waits for Kingu's answer: a session grant or a deny reason can reach it. */
	const held = $derived(!!asking && !!cliSessions.sessions[slug]?.hookToken && !!liveHold(hook, cliSessions.now));
	const grants = $derived<Grant[]>(held && request && !request.unsandboxed ? request.grants : []);
	/** What "Always allow" (in this project or everywhere) would save: Claude's suggested allow rules. */
	const rules = $derived(scopedGrants(grants, 'project'));
	const scopes = $derived(rules.length ? permissionGrants.scopesOf(cliSessions.sessions[slug]?.hookToken, liveHold(hook, cliSessions.now)?.id) : undefined);
	const grantText = (g: Grant) => (g.kind === 'mode' ? t('legacyAde.cliQuestion.grantMode') : g.kind === 'dir' ? t('legacyAde.cliQuestion.grantDir', { dir: g.value }) : t('legacyAde.cliQuestion.grantRule', { rule: g.value }));
	let answering = $state(false);
	let why = $state('');
	$effect(() => {
		// A new prompt starts without the last one's reason.
		void asking;
		why = '';
	});
	async function permit(allow: boolean, scope?: GrantScope) {
		if (answering) return;
		answering = true;
		try {
			const shown = scope ? scopedGrants(grants, scope).map(grantKey) : undefined;
			const ok = await cliSessions.answerPermission(slug, allow, { session: shown, scope, message: allow ? undefined : why });
			if (!ok) status.flash(t(scope ? 'legacyAde.cliQuestion.sessionFailed' : 'legacyAde.cliQuestion.sendFailed'), 6000);
			else if (scope === 'project' || scope === 'user') status.flash(t('legacyAde.cliQuestion.savedRules', { count: shown?.length ?? 0 }), 6000);
		} finally {
			answering = false;
		}
	}
</script>

{#if asking && asking !== hidden}
	<div class={klass}>
		<div class="space-y-2 rounded-md border border-(--vscode-editorWarning-foreground) bg-(--vscode-editorWidget-background) p-3" role="alertdialog" aria-label={t('legacyAde.cliQuestion.permissionTitle')}>
			<div class="text-xs font-medium">{t('legacyAde.cliQuestion.permissionTitle')}</div>
			<div class="text-xs break-words text-(--vscode-descriptionForeground)">{hook?.message}</div>
			{#if request?.detail}
				<pre class="max-h-40 overflow-auto rounded bg-(--vscode-textCodeBlock-background) p-2 font-mono text-xs break-words whitespace-pre-wrap">{request.detail}</pre>
			{/if}
			{#if request?.unsandboxed}
				<div class="text-xs text-(--vscode-editorWarning-foreground)">{t('legacyAde.cliQuestion.unsandboxed')}</div>
			{/if}
			{#if held}
				<input class="{INPUT} text-xs" type="text" maxlength={MAX_DENY_MESSAGE} bind:value={why} placeholder={t('legacyAde.cliQuestion.denyReason')} aria-label={t('legacyAde.cliQuestion.denyReason')} />
			{/if}
			<div class="flex flex-wrap items-center gap-1.5">
				<button class={BUTTON} disabled={answering} onclick={() => permit(true)}>{t('legacyAde.cliQuestion.allow')}</button>
				{#if grants.length}
					<button class={BUTTON_SECONDARY} disabled={answering} onclick={() => permit(true, 'session')}>{t('legacyAde.cliQuestion.allowSession')}</button>
				{/if}
				{#if rules.length}
					<button class={BUTTON_SECONDARY} disabled={answering} onclick={() => permit(true, 'project')}>{t('legacyAde.cliQuestion.allowProject')}</button>
					<button class={BUTTON_SECONDARY} disabled={answering} onclick={() => permit(true, 'user')}>{t('legacyAde.cliQuestion.allowUser')}</button>
				{/if}
				<button class={BUTTON_SECONDARY} disabled={answering} onclick={() => permit(false)}>{t('legacyAde.cliQuestion.deny')}</button>
				<button class="ml-auto text-[11px] text-(--vscode-textLink-foreground) hover:underline" onclick={() => (hidden = asking)}>{t('legacyAde.cliQuestion.dismiss')}</button>
			</div>
			{#if grants.length}
				<div class="text-[11px] text-(--vscode-descriptionForeground)">
					<div>{t('legacyAde.cliQuestion.sessionGrants', { agent: run ? cliName(run) : 'agent' })}</div>
					<ul class="list-disc pl-4">
						{#each grants as g (grantKey(g))}
							<li class="break-words">{grantText(g)}</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if rules.length}
				<div class="text-[11px] text-(--vscode-descriptionForeground)">
					<div>{t('legacyAde.cliQuestion.alwaysRules', { agent: run ? cliName(run) : 'agent' })}</div>
					<ul class="list-disc pl-4">
						{#each rules as g (grantKey(g))}
							<li class="break-words">{grantText(g)}</li>
						{/each}
					</ul>
					{#if scopes?.project}
						<div class="break-words">{t('legacyAde.cliQuestion.projectFile', { file: scopes.project.files.join(' · ') })}</div>
					{/if}
					{#if scopes?.user}
						<div class="break-words">{t('legacyAde.cliQuestion.userFile', { file: scopes.user.files.join(' · ') })}</div>
					{/if}
					{#if scopes?.project?.tracked || scopes?.user?.tracked}
						<div class="text-(--vscode-editorWarning-foreground)">{t(scopes?.project?.tracked ? 'legacyAde.cliQuestion.trackedProject' : 'legacyAde.cliQuestion.trackedUser')}</div>
					{/if}
					<button class="text-(--vscode-textLink-foreground) hover:underline" onclick={() => void permissionGrants.show()}>{t('legacyAde.cliQuestion.manageGrants')}</button>
				</div>
			{/if}
			<div class="text-[11px] text-(--vscode-descriptionForeground)">{t(held ? 'legacyAde.cliQuestion.permissionNoteHeld' : 'legacyAde.cliQuestion.permissionNote', { agent: run ? cliName(run) : 'agent' })}</div>
		</div>
	</div>
{/if}

{#if ask && id !== hidden}
	{#key id}
		<div class={klass}>
			<QuestionCard
				prompt={ask}
				submitLabel={t('legacyAde.cliQuestion.submit')}
				dismissLabel={t('legacyAde.cliQuestion.dismiss')}
				note={t('legacyAde.cliQuestion.note', { agent: run ? cliName(run) : 'agent' })}
				onsubmit={async (sels) => {
					if (!(await cliSessions.answer(slug, sels))) status.flash(t('legacyAde.cliQuestion.sendFailed'), 6000);
				}}
				ondismiss={() => (hidden = id)}
			/>
		</div>
	{/key}
{/if}
