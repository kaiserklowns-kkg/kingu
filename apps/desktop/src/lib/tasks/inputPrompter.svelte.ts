// The quick-input prompter for `${input:…}` and `${command:…}` (VS Code: configurationResolver's
// showUserInput), shared by tasks.json and launch.json so both ask the same way. `type: command`
// inputs and `${command:…}` run what Kingu can answer: the process pickers the debuggers use, and
// a Kingu command whose run returns a string. Anything else is not run (no extension host).

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import type { InputPrompter } from './variables.ts';

/** The process-picker commands of lldb, Delve, debugpy and js-debug (`${command:pickProcess}`). */
export const PICK_PROCESS_COMMANDS = new Set(['pickprocess', 'extension.picknodeprocess', 'pickremoteprocess', 'python.pickprocess', 'lldb.pickprocess']);

export const isPickProcess = (command: string) => PICK_PROCESS_COMMANDS.has(command.toLowerCase());

/** A process id, null when cancelled. */
async function pickProcess(): Promise<string | null> {
	const list = await invoke<{ pid: number; command: string }[]>('debug_processes').catch(() => []);
	const item = await quick.choose({
		placeholder: t('debugger.pickProcess'),
		items: list.map((p) => ({ id: String(p.pid), label: p.command.split('/').pop()?.split(' ')[0] ?? p.command, description: `${p.pid} ${p.command}` }))
	});
	return item?.id ?? null;
}

/** A command's string result; undefined when Kingu cannot run it (or it returned nothing), null when cancelled. */
export async function runVariableCommand(command: string): Promise<string | null | undefined> {
	if (isPickProcess(command)) return pickProcess();
	const cmd = commands.get(command);
	if (!cmd || (cmd.when && !cmd.when())) return undefined;
	const value = await cmd.run();
	return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

export function inputPrompter(): InputPrompter {
	return {
		promptString: (input) =>
			quick.input({
				placeholder: input.description ?? input.id,
				value: input.default,
				password: input.password,
				hint: (v) => (v ? t('ideTasks.input.hint', { value: input.password ? '•'.repeat(v.length) : v }) : (input.description ?? input.id))
			}),
		pickString: async (input) => {
			const picked = await quick.choose({
				placeholder: input.description ?? input.id,
				items: input.options.map((o) => ({ id: o.value, label: o.label ?? o.value, description: o.label ? o.value : undefined })),
				activeId: input.default
			});
			return picked?.id;
		},
		command: (command) => runVariableCommand(command)
	};
}
