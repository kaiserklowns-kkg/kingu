/**
 * `chatTools` — a chat's tools (chatTools.ts): the Configure Tools picker (ChatToolPicker.svelte),
 * the tool sets of where the chat runs (Rust `chat_tool_sets`), and `#set` references in a prompt.
 *
 *   chatTools.current           the chat commands act on (the chat panel's or chat editor's, set by AgentPanel)
 *   chatTools.configure(id)     opens the picker for chat `id`
 *   chatTools.groups(id)        what the picker lists for that chat
 *   chatTools.apply(id, off)    saves the chat's off list (chats.setDisabledTools)
 *   chatTools.promptRefs(id, text, cwd)  `#set`s of a prompt: their tools on again, and the context
 *                               line that tells the agent what they are
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { mcp } from '#lib/mcp/mcp.svelte.ts';
import { chats } from './chats.svelte.ts';
import { chatCwdPath } from './chats.ts';
import type { ContextText } from './chatPrompt.ts';
import { ARKAI_RUNTIME } from './arkai.ts';
import { CLAUDE_RUNTIME, runtimeOf } from './runtimes.ts';
import { ARKAI_TOOLS, CLAUDE_TOOLS, setTools, toolGroups, toolSetContext, toolSetRefs, type ToolGroup, type ToolServer, type ToolSet } from './chatTools.ts';

class ChatTools {
	current = $state<string | null>(null);
	/** The chat whose picker is open. */
	picking = $state<string | null>(null);
	sets = $state<ToolSet[]>([]);
	#setsFor: string | null = null;

	/** Tool sets of `cwd` (and the user's), read again when asked for another folder or `force`. */
	async loadSets(cwd: string | null, force = false): Promise<ToolSet[]> {
		if (!cwd) return (this.sets = []);
		if (!force && this.#setsFor === cwd) return this.sets;
		this.#setsFor = cwd;
		this.sets = await invoke<ToolSet[]>('chat_tool_sets', { cwd }).catch(() => []);
		return this.sets;
	}

	cwdOf(id: string): string | null {
		const meta = chats.get(id);
		return meta && workspace.root ? chatCwdPath(workspace.root, meta.cwd) : workspace.root;
	}

	/** Whether Kingu can take tools away from the chat's agent: the Claude SDK and Arkai can; ACP agents and Codex pick their own. */
	filters(id: string): boolean {
		const r = runtimeOf(chats.get(id));
		return r === CLAUDE_RUNTIME || r === ARKAI_RUNTIME;
	}

	servers(): ToolServer[] {
		return mcp.rows.filter((r) => r.enabled).map((r) => ({ name: r.name, tools: r.live?.tools ?? [] }));
	}

	groups(id: string): ToolGroup[] {
		const builtins = runtimeOf(chats.get(id)) === ARKAI_RUNTIME ? ARKAI_TOOLS : CLAUDE_TOOLS;
		return toolGroups({ sets: this.sets, builtins, servers: this.servers() }, { sets: t('chatTools.group.sets'), builtin: t('chatTools.group.builtin') });
	}

	/** Configure Tools… for chat `id` (the current chat when omitted). */
	async configure(id: string | null = this.current) {
		if (!id || !chats.get(id)) return status.flash(t('chatTools.noChat'), 5000);
		await this.loadSets(this.cwdOf(id), true);
		this.picking = id;
	}

	async apply(id: string, off: string[]) {
		const restarted = await chats.setDisabledTools(id, off);
		if (restarted) status.flash(t('chatTools.saved', { count: off.length }), 4000);
	}

	/**
	 * The tool sets `text` names (`#reader`): their tools are turned back on for the chat (a new run
	 * picks them up), and the agent is told what each set holds.
	 */
	async promptRefs(id: string | null, text: string, cwd: string | null): Promise<ContextText[]> {
		if (!text.includes('#')) return [];
		const refs = toolSetRefs(text, await this.loadSets(cwd));
		if (!refs.length) return [];
		const meta = id ? chats.get(id) : undefined;
		const off = meta?.disabled_tools ?? [];
		if (meta && off.length) {
			const next = setTools(off, refs.flatMap((r) => r.resolved), true, this.servers());
			if (next.length !== off.length || next.some((x, i) => x !== off[i])) await chats.setDisabledTools(meta.id, next);
		}
		return [{ kind: 'tools', label: refs.map((r) => `#${r.name}`).join(' '), text: toolSetContext(refs) }];
	}
}

export const chatTools = new ChatTools();
