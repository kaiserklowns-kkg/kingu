// VS Code's chat customization commands (promptFileActions / newPromptFileActions), in the palette:
//   workbench.action.chat.configure.prompts        Configure Prompt Files...  (open one, or new)
//   workbench.action.chat.configure.customagents   Configure Custom Agents...
//   workbench.action.chat.configure.instructions   Configure Instructions...
//   workbench.command.new.prompt / .agent / .instructions   New Prompt File / Custom Agent / Instructions File...
// New files go to VS Code's default workspace folders (.github/prompts, .github/agents,
// .github/instructions); Rust lists what exists (agent/customizations.rs, agent/rules.rs).

import { invoke } from '@tauri-apps/api/core';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { newCustomizationFile, validFileName, type CustomizationKind, type Customizations } from './customizations.ts';

type Rule = { path: string; rel: string; kind: string; description: string | null };

async function newFile(kind: CustomizationKind) {
	if (!workspace.root) return status.flash(t('chatCustomize.noFolder'), 5000);
	const name = await quick.input({
		placeholder: t(`chatCustomize.new.${kind}.placeholder`),
		hint: (v) => (!v.trim() ? t('chatCustomize.new.hint') : validFileName(v) ? newCustomizationFile(kind, v).rel : t('chatCustomize.new.badName'))
	});
	if (!name || !validFileName(name)) return;
	const file = newCustomizationFile(kind, name);
	try {
		await invoke('fs_create_file', { rel: file.rel });
		await invoke('fs_write_file', { rel: file.rel, content: file.content });
	} catch (e) {
		return status.flash(String(e), 8000);
	}
	editors.open(file.rel, { preview: false });
}

const NEW_ROW = '\u0000new';

async function configure(kind: CustomizationKind) {
	if (!workspace.root) return status.flash(t('chatCustomize.noFolder'), 5000);
	let items: PickItem[] = [];
	if (kind === 'instructions') {
		const rules = await invoke<Rule[]>('chat_rules', { cwd: workspace.root, files: [] }).catch(() => [] as Rule[]);
		items = rules.map((r) => ({ id: r.path, label: r.rel.split('/').pop() || r.rel, description: [r.rel, r.description ?? ''].filter(Boolean).join(' · '), icon: r.rel }));
	} else {
		const got = await invoke<Customizations>('chat_customizations', { cwd: workspace.root }).catch(() => ({ prompts: [], agents: [] }) as Customizations);
		const rows = kind === 'prompt' ? got.prompts.map((p) => ({ name: `/${p.name}`, path: p.path, rel: p.rel, description: p.description })) : got.agents.map((a) => ({ name: a.name, path: a.path, rel: a.rel, description: a.description }));
		items = rows.map((r) => ({ id: r.path, label: r.name, description: [r.rel, r.description].filter(Boolean).join(' · '), icon: r.rel }));
	}
	const item = await quick.choose({ placeholder: t(`chatCustomize.configure.${kind}`), items: [{ id: NEW_ROW, label: t(`chatCustomize.new.${kind}`) }, ...items] });
	if (!item) return;
	if (item.id === NEW_ROW) return newFile(kind);
	editors.open(item.id, { preview: false });
}

export function registerCustomizeCommands(): () => void {
	const off = [
		commands.register({ id: 'workbench.action.chat.configure.prompts', title: 'Configure Prompt Files...', category: 'Chat', run: () => configure('prompt') }),
		commands.register({ id: 'workbench.action.chat.configure.customagents', title: 'Configure Custom Agents...', category: 'Chat', run: () => configure('agent') }),
		commands.register({ id: 'workbench.action.chat.configure.instructions', title: 'Configure Instructions...', category: 'Chat', run: () => configure('instructions') }),
		commands.register({ id: 'workbench.command.new.prompt', title: 'New Prompt File...', category: 'Chat', run: () => newFile('prompt') }),
		commands.register({ id: 'workbench.command.new.agent', title: 'New Custom Agent...', category: 'Chat', run: () => newFile('agent') }),
		commands.register({ id: 'workbench.command.new.instructions', title: 'New Instructions File...', category: 'Chat', run: () => newFile('instructions') })
	];
	return () => off.forEach((f) => f());
}
