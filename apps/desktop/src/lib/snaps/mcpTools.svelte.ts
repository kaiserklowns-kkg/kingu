// "MCP: Run Tool…": pick an MCP server (the ones agents in this folder get, Snap servers confined
// and with their secrets), pick one of its tools, fill its arguments (one input per schema field,
// or one JSON object), run it and show the result in the "MCP Tools" output channel.

import { invoke } from '@tauri-apps/api/core';
import { mcpServers, prepareMcp } from '#lib/ade/mcp.ts';
import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
import { worktreeDir } from '#lib/ade/keys.ts';
import { output } from '#lib/output/output.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { argsTemplate, fieldHint, parseArgsJson, parseField, resultText, runnableServers, schemaFields, type ToolInfo } from './mcpTools.ts';

export const TOOLS_CHANNEL = 'MCP Tools';
const JSON_PICK = '__json';

/** The folder tools run in: the selected task worktree in the ADE, else the open folder. */
function toolRoot(): string | null {
	if (!workspace.root) return null;
	const slug = appMode.isAgents ? adeLayout.key : '';
	return slug ? `${workspace.root}/${worktreeDir(slug)}` : workspace.root;
}

/** Asks for each field in turn; undefined when the user cancels. */
async function askArgs(tool: ToolInfo): Promise<Record<string, unknown> | undefined> {
	const fields = schemaFields(tool.inputSchema);
	if (!fields.length) return {};
	const how = await quick.choose({
		placeholder: t('snapPlatform.tools.argsHow', { tool: tool.name }),
		items: [
			{ id: 'form', label: t('snapPlatform.tools.form'), description: fields.map((f) => f.name).join(', ') },
			{ id: JSON_PICK, label: t('snapPlatform.tools.json'), description: '{ … }' }
		]
	});
	if (!how) return undefined;
	if (how.id === JSON_PICK) {
		for (;;) {
			const text = await quick.input({ placeholder: t('snapPlatform.tools.jsonPlaceholder', { tool: tool.name }), value: argsTemplate(fields), hint: (v) => { const r = parseArgsJson(v); return 'error' in r ? r.error : t('snapPlatform.tools.enterToRun'); } });
			if (text === undefined) return undefined;
			const r = parseArgsJson(text);
			if ('value' in r) return r.value;
			status.flash(r.error);
		}
	}
	const args: Record<string, unknown> = {};
	for (const f of fields) {
		for (;;) {
			const text = await quick.input({ placeholder: `${tool.name} › ${f.name}`, value: f.default !== undefined ? String(typeof f.default === 'object' ? JSON.stringify(f.default) : f.default) : '', hint: (v) => fieldHint(f, v) });
			if (text === undefined) return undefined;
			const r = parseField(f, text);
			if ('value' in r) {
				if (r.value !== undefined) args[f.name] = r.value;
				break;
			}
			status.flash(r.error);
		}
	}
	return args;
}

export async function runMcpTool() {
	const root = toolRoot();
	await prepareMcp();
	const servers = runnableServers(mcpServers(root));
	const names = Object.keys(servers);
	if (!names.length) {
		status.flash(t('snapPlatform.tools.noServers'));
		return;
	}
	const server = names.length === 1 ? names[0] : (await quick.choose({ placeholder: t('snapPlatform.tools.pickServer'), items: names.map((n) => ({ id: n, label: n, description: [servers[n].command, ...servers[n].args].join(' ').slice(0, 120) })) }))?.id;
	if (!server) return;
	const s = servers[server];
	const spec = { command: s.command, args: s.args, env: s.env, cwd: root };
	let tools: ToolInfo[];
	try {
		status.flash(t('snapPlatform.tools.listing', { server }));
		tools = await invoke<ToolInfo[]>('mcp_tools_list', { spec });
	} catch (e) {
		notifications.error(t('snapPlatform.tools.failed', { server, error: String(e) }));
		return;
	}
	if (!tools.length) {
		status.flash(t('snapPlatform.tools.noTools', { server }));
		return;
	}
	const picked = await quick.choose({ placeholder: t('snapPlatform.tools.pickTool', { server }), items: tools.map((x) => ({ id: x.name, label: x.title || x.name, description: x.description?.split('\n')[0] ?? '' })) });
	const tool = tools.find((x) => x.name === picked?.id);
	if (!tool) return;
	const args = await askArgs(tool);
	if (!args) return;
	output.append(TOOLS_CHANNEL, `… ${server} · ${tool.name}`);
	output.show(TOOLS_CHANNEL);
	try {
		const result = await invoke<Parameters<typeof resultText>[3]>('mcp_tool_call', { spec, tool: tool.name, arguments: args });
		output.append(TOOLS_CHANNEL, resultText(server, tool.name, args, result));
	} catch (e) {
		output.append(TOOLS_CHANNEL, [`✗ ${server} · ${tool.name}: ${String(e)}`, '']);
	}
}
