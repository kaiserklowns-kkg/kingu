<script lang="ts">
	// "N rules" in the chat input's context row (Cursor's rules pill): the rules files the agent
	// follows in this chat besides CLAUDE.md (Rust agent/rules.rs: AGENTS.md, .cursor/rules,
	// Copilot's instructions) for the attached files. Clicking lists them; picking one opens it.
	// Hidden with kingu.chat.rules.enabled off or no rules.
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '#lib/workbench/Icon.svelte';
	import { quick } from '#lib/workbench/quick.svelte.ts';
	import { editors } from '#lib/workbench/editors.svelte.ts';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { t } from '#lib/i18n/index.ts';

	type Rule = { path: string; rel: string; kind: 'agents' | 'cursor' | 'copilot' | 'instructions'; description: string | null; always: boolean; globs: string[]; applies: boolean };

	let { cwd, files = [] }: { cwd: string | null; files?: string[] } = $props();

	let rules = $state<Rule[]>([]);
	const active = $derived(rules.filter((r) => r.applies));
	const enabled = $derived(settings.get<boolean>('kingu.chat.rules.enabled') !== false);
	const key = $derived(JSON.stringify([cwd, files]));

	$effect(() => {
		void key;
		if (!enabled || !cwd) {
			rules = [];
			return;
		}
		let live = true;
		invoke<Rule[]>('chat_rules', { cwd, files: $state.snapshot(files) })
			.then((r) => live && (rules = r))
			.catch(() => live && (rules = []));
		return () => {
			live = false;
		};
	});

	const KIND = {
		agents: () => t('chat.rules.kind.agents'),
		cursor: () => t('chat.rules.kind.cursor'),
		copilot: () => t('chat.rules.kind.copilot'),
		instructions: () => t('chatCustomize.rules.instructions')
	} as const;

	async function pick() {
		const item = await quick.choose({
			placeholder: t('chat.rules.pick'),
			items: active.map((r) => ({
				id: r.path,
				label: r.rel,
				description: [KIND[r.kind](), r.kind === 'cursor' || r.kind === 'instructions' ? (r.always ? t('chat.rules.always') : t('chat.rules.matched')) : '', r.description ?? ''].filter(Boolean).join(' · '),
				icon: r.rel
			}))
		});
		if (item) editors.open(item.id);
	}
</script>

{#if active.length}
	<button
		type="button"
		class="flex items-center gap-1 rounded border border-(--vscode-widget-border) px-1.5 py-0.5 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground)"
		title={t('chat.rules.hint')}
		onclick={pick}
	>
		<Icon name="listChecks" size={12} />{t('chat.rules.chip', { count: active.length })}
	</button>
{/if}
