// TypeScript commands of VS Code's TypeScript extension (typescript-language-features): Go to Source
// Definition, Find File References and Select TypeScript Version, over typescript-language-server
// (lsp.svelte.ts, typescriptExtras.ts). The chosen version is kept per workspace, like VS Code's
// `typescript.useWorkspaceTsdk` workspace state.

import { invoke } from '@tauri-apps/api/core';
import { lsp } from './lsp.svelte.ts';
import { packageJsonOf, packageVersion, workspaceTsdk, type TsVersionChoice } from './typescriptExtras.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspaceStorage } from '#lib/workbench/workspaceStorage.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { baseName } from '#lib/workbench/fileTree.ts';
import { t } from '#lib/i18n/index.ts';

const STORE = 'kingu.typescript';
const TS_LANGUAGES = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

type Hit = { rel: string; line: number; column: number };

/** One location opens; several are listed to pick from. */
function showLocations(hits: Hit[], placeholder: string) {
	if (hits.length === 1) return editors.openFromCodeNavigation(hits[0].rel, hits[0].line, hits[0].column);
	const items: PickItem[] = hits.map((h, i) => ({ id: String(i), label: baseName(h.rel), description: `${h.rel}:${h.line}`, icon: h.rel }));
	quick.pick({ placeholder, items, onAccept: (item) => editors.openFromCodeNavigation(hits[Number(item.id)].rel, hits[Number(item.id)].line, hits[Number(item.id)].column) });
}

async function goToSourceDefinition() {
	const rel = editors.active;
	if (!rel || !lsp.isTypeScriptDoc(rel)) return status.flash(t('tools.lsp.noTypeScript'));
	try {
		const hits = await lsp.sourceDefinition(rel, editors.cursor.line, editors.cursor.column);
		if (!hits?.length) return status.flash(t('tools.lsp.noSourceDefinition'));
		showLocations(hits, t('tools.lsp.sourceDefinitions'));
	} catch (e) {
		status.error(String(e instanceof Error ? e.message : e));
	}
}

async function findFileReferences(rel = editors.active) {
	if (!rel || !lsp.isTypeScriptDoc(rel)) return status.flash(t('tools.lsp.noTypeScript'));
	try {
		const hits = await lsp.fileReferences(rel);
		if (!hits?.length) return status.flash(t('tools.lsp.noFileReferences'));
		showLocations(hits, t('tools.lsp.fileReferences', { name: baseName(rel) }));
	} catch (e) {
		status.error(String(e instanceof Error ? e.message : e));
	}
}

/** VS Code's Select TypeScript Version: the language server's own TypeScript, or the workspace's. */
async function selectTypeScriptVersion() {
	const lib = workspaceTsdk({ get: (id) => settings.get(id), isSet: (id) => (settings.resolved.get(id)?.source ?? 'default') !== 'default' });
	const version = await invoke<string>('read_workspace_file', { rel: packageJsonOf(lib) }).then(packageVersion, () => null);
	const current = (choice: TsVersionChoice) => (lsp.tsVersion === choice ? ` · ${t('tools.lsp.tsVersionCurrent')}` : '');
	const items: PickItem[] = [{ id: 'bundled', label: t('tools.lsp.tsVersionBundled'), description: current('bundled').replace(/^ · /, '') }];
	if (version) items.push({ id: 'workspace', label: t('tools.lsp.tsVersionWorkspace'), description: `${version} · ${lib}${current('workspace')}` });
	else items.push({ id: 'missing', label: t('tools.lsp.tsVersionWorkspace'), description: t('tools.lsp.tsVersionMissing', { path: lib }) });
	quick.pick({
		placeholder: t('tools.lsp.tsVersionPlaceholder'),
		items,
		activeId: lsp.tsVersion,
		onAccept: (item) => {
			if (item.id !== 'bundled' && item.id !== 'workspace') return;
			lsp.tsVersion = item.id;
			workspaceStorage.save(STORE, { version: item.id });
		}
	});
}

/** Registers the TypeScript commands and follows the workspace's chosen version; returns the uninstall function. */
export function installTypeScriptCommands(): () => void {
	workspaceStorage.register(STORE, ['version'], (saved) => {
		lsp.tsVersion = saved?.version === 'workspace' ? 'workspace' : 'bundled';
	});
	const tsFile = () => editors.active !== null && TS_LANGUAGES.has(editors.language);
	const unregister = [
		commands.register({ id: 'typescript.goToSourceDefinition', title: 'Go to Source Definition', category: 'TypeScript', when: tsFile, run: () => void goToSourceDefinition() }),
		commands.register({ id: 'typescript.findAllFileReferences', title: 'Find File References', category: 'TypeScript', when: tsFile, run: () => void findFileReferences() }),
		commands.register({ id: 'typescript.selectTypeScriptVersion', title: 'Select TypeScript Version...', category: 'TypeScript', run: () => void selectTypeScriptVersion() })
	];
	return () => unregister.forEach((u) => u());
}
