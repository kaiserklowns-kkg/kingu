<script lang="ts">
	// An MCP server asking in the chat (VS Code's chatElicitationContentPart and the sampling
	// prompt of mcpSamplingService): a form built from the server's schema (text, number, a
	// checkbox, a single-select; required ones marked), answered Submit / Decline / Cancel; a page
	// the server wants opened (url mode: Open in Browser accepts); or leave to make a model call,
	// with what it would send and VS Code's Allow in this Session / Always / Not Now / Never (Always
	// and Never are saved in chat.mcp.serverSampling). Once answered: one quiet line. The form
	// model is mcpChat.ts.
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import type { McpAction, McpRequestEvent } from './events';
	import { formContent, formFields, initialValues, type FieldError, type FormField } from './mcpChat.ts';

	let {
		request,
		action,
		onanswer
	}: {
		request: McpRequestEvent;
		/** How it was answered; absent while it waits. */
		action?: McpAction;
		/** Absent: the card only says it waits (the run is not this view's to answer, or it ended). */
		onanswer?: (action: McpAction, content?: Record<string, string | number | boolean>, remember?: 'session' | 'always' | 'never') => unknown;
	} = $props();

	// One card per request: its schema never changes underneath it.
	const fields = $derived(request.type === 'elicitation' && request.mode !== 'url' ? formFields(request.schema) : null);
	let values = $state<Record<string, string | boolean>>({});
	let errors = $state<Record<string, FieldError>>({});
	let tried = $state(false);
	let sent = $state(false);
	let showRequest = $state(false);
	$effect.pre(() => {
		if (fields && !Object.keys(values).length) values = initialValues(fields);
	});
	const minutes = $derived(Math.max(1, Math.round(request.timeout_ms / 60_000)));

	function errorText(f: FormField, e: FieldError): string {
		switch (e) {
			case 'min':
			case 'minLength':
				return t(e === 'min' ? 'chatMcp.error.min' : 'chatMcp.error.minLength', { min: f.min ?? 0 });
			case 'max':
			case 'maxLength':
				return t(e === 'max' ? 'chatMcp.error.max' : 'chatMcp.error.maxLength', { max: f.max ?? 0 });
			default:
				return t(`chatMcp.error.${e}`);
		}
	}

	async function act(a: McpAction, content?: Record<string, string | number | boolean>, remember?: 'session' | 'always' | 'never') {
		if (sent || !onanswer) return;
		sent = true;
		try {
			await onanswer(a, content, remember);
		} finally {
			// The card turns into its line on `mcp_request_resolved`; re-enable if that never comes.
			setTimeout(() => (sent = false), 3000);
		}
	}

	function submit() {
		if (!fields) return;
		tried = true;
		const r = formContent(fields, $state.snapshot(values));
		if ('errors' in r) return void (errors = r.errors);
		errors = {};
		void act('accept', r.content);
	}

	function revalidate() {
		if (!tried || !fields) return;
		const r = formContent(fields, $state.snapshot(values));
		errors = 'errors' in r ? r.errors : {};
	}

	const resolvedText = $derived.by(() => {
		if (!action) return '';
		if (request.type === 'sampling') return t(action === 'accept' ? 'chatMcp.sampling.allowed' : 'chatMcp.sampling.refused', { server: request.server });
		return t(`chatMcp.resolved.${action}`, { server: request.server });
	});
	const inputClass =
		'w-full rounded border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) px-2 py-0.5 text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder) disabled:opacity-60';
	const primary = 'rounded bg-(--vscode-button-background) px-2 py-0.5 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-50';
	const secondary = 'rounded bg-(--vscode-button-secondaryBackground) px-2 py-0.5 text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground) disabled:opacity-50';
</script>

{#if action}
	<div class="flex items-center gap-1.5 text-(--vscode-descriptionForeground)">
		<Icon name={action === 'accept' ? 'check' : 'circleDashed'} size={13} />
		<span class="truncate">{resolvedText}</span>
	</div>
{:else if !onanswer}
	<div class="flex items-center gap-1.5 text-(--vscode-editorWarning-foreground)">
		<Icon name="question" size={13} />
		<span class="truncate">{t('chatMcp.waiting', { server: request.server })}</span>
	</div>
{:else if request.type === 'sampling'}
	{@const s = request.sampling}
	<div class="space-y-2 rounded border border-(--vscode-editorWarning-foreground)/60 bg-(--vscode-editorWidget-background) p-2 text-(--vscode-foreground)" role="group" aria-label={t('chatMcp.sampling.title', { server: request.server })}>
		<div class="flex items-center gap-1.5 font-medium"><Icon name="sparkle" size={13} />{t('chatMcp.sampling.title', { server: request.server })}</div>
		<p class="text-(--vscode-descriptionForeground)">{t('chatMcp.sampling.desc')}</p>
		{#if s}
			<button type="button" class="flex items-center gap-1 text-(--vscode-textLink-foreground) hover:underline" aria-expanded={showRequest} onclick={() => (showRequest = !showRequest)}>
				<Icon name={showRequest ? 'chevronDown' : 'chevronRight'} size={12} />{s.messages.length} · {s.max_tokens ? t('chatMcp.sampling.maxTokens', { count: s.max_tokens }) : ''}
			</button>
			{#if showRequest}
				<div class="max-h-60 space-y-1 overflow-auto rounded border border-(--vscode-widget-border) p-1.5 text-xs">
					{#if s.system_prompt}
						<div><span class="font-semibold">{t('chatMcp.sampling.system')}:</span> <span class="whitespace-pre-wrap">{s.system_prompt}</span></div>
					{/if}
					{#each s.messages as m, i (i)}
						<div><span class="font-semibold uppercase">{m.role}:</span> <span class="whitespace-pre-wrap">{m.text}</span></div>
					{/each}
				</div>
			{/if}
		{/if}
		<div class="flex flex-wrap gap-1.5">
			<button type="button" class={primary} disabled={sent} onclick={() => act('accept', undefined, 'session')}>{t('chatMcp.sampling.session')}</button>
			<button type="button" class={secondary} disabled={sent} title={t('chatMcp.sampling.alwaysHint')} onclick={() => act('accept', undefined, 'always')}>{t('chatMcp.sampling.always')}</button>
			<button type="button" class={secondary} disabled={sent} onclick={() => act('decline')}>{t('chatMcp.sampling.notNow')}</button>
			<button type="button" class={secondary} disabled={sent} title={t('chatMcp.sampling.alwaysHint')} onclick={() => act('decline', undefined, 'never')}>{t('chatMcp.sampling.never')}</button>
		</div>
	</div>
{:else}
	<div class="space-y-2 rounded border border-(--vscode-charts-purple,#B180D7)/70 bg-(--vscode-editorWidget-background) p-2 text-(--vscode-foreground)" role="group" aria-label={t('chatMcp.elicit.title', { server: request.server })}>
		<div class="flex items-center gap-1.5 font-medium text-(--vscode-charts-purple,#B180D7)"><Icon name="ports" size={13} />{request.mode === 'url' ? t('chatMcp.url.title', { server: request.server }) : t('chatMcp.elicit.title', { server: request.server })}</div>
		{#if request.message}<p class="whitespace-pre-wrap">{request.message}</p>{/if}
		{#if request.mode === 'url'}
			<p class="truncate font-mono text-xs text-(--vscode-descriptionForeground)" title={request.url ?? ''}>{request.url}</p>
		{:else if fields}
			<form class="space-y-1.5" onsubmit={(e) => (e.preventDefault(), submit())}>
				{#each fields as f (f.name)}
					{@const id = `mcp-${request.request_id}-${f.name}`}
					{@const err = errors[f.name]}
					<div>
						{#if f.type === 'boolean'}
							<label class="flex items-center gap-1.5">
								<input type="checkbox" {id} disabled={sent} checked={values[f.name] === true} onchange={(e) => ((values[f.name] = e.currentTarget.checked), revalidate())} />
								<span>{f.label}</span>
							</label>
						{:else}
							<label for={id} class="mb-0.5 block">
								{f.label}{#if f.required}<span class="text-(--vscode-descriptionForeground)"> ({t('chatMcp.elicit.required')})</span>{/if}
							</label>
							{#if f.options}
								<select {id} class={inputClass} disabled={sent} value={String(values[f.name] ?? '')} aria-invalid={!!err} onchange={(e) => ((values[f.name] = e.currentTarget.value), revalidate())}>
									<option value="">{t('chatMcp.elicit.choose')}</option>
									{#each f.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
								</select>
							{:else}
								<input
									{id}
									class={inputClass}
									type={f.type === 'string' ? (f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : f.format === 'date' ? 'date' : 'text') : 'number'}
									step={f.type === 'integer' ? 1 : 'any'}
									disabled={sent}
									aria-invalid={!!err}
									value={String(values[f.name] ?? '')}
									oninput={(e) => ((values[f.name] = e.currentTarget.value), revalidate())}
								/>
							{/if}
						{/if}
						{#if f.description}<div class="text-xs text-(--vscode-descriptionForeground)">{f.description}</div>{/if}
						{#if err}<div class="text-xs text-(--vscode-errorForeground)" role="alert">{errorText(f, err)}</div>{/if}
					</div>
				{/each}
				<button type="submit" class="hidden" tabindex="-1" aria-hidden="true"></button>
			</form>
		{:else}
			<p class="text-(--vscode-descriptionForeground)">{t('chatMcp.elicit.unsupported')}</p>
		{/if}
		<div class="text-xs text-(--vscode-descriptionForeground)">{t('chatMcp.elicit.expires', { minutes })}</div>
		<div class="flex flex-wrap gap-1.5">
			{#if request.mode === 'url'}
				<button type="button" class={primary} disabled={sent} onclick={() => act('accept')}>{t('chatMcp.url.open')}</button>
			{:else if fields}
				<button type="button" class={primary} disabled={sent} onclick={submit}>{t('chatMcp.elicit.submit')}</button>
			{/if}
			<button type="button" class={secondary} disabled={sent} onclick={() => act('decline')}>{t('chatMcp.elicit.decline')}</button>
			<button type="button" class={secondary} disabled={sent} onclick={() => act('cancel')}>{t('chatMcp.elicit.cancel')}</button>
		</div>
	</div>
{/if}
