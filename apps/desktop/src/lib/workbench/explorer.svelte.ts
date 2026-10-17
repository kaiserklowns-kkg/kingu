import { invoke } from '@tauri-apps/api/core';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';

export type DirEntry = { name: string; rel: string; is_dir: boolean };
export type Row = DirEntry & { depth: number; expanded: boolean };

// Lazily loaded tree: a directory's children are fetched the first time it is expanded.
class Explorer {
	children = new SvelteMap<string, DirEntry[]>();
	expanded = new SvelteSet<string>();
	error = $state('');

	async load(rel: string) {
		try {
			const entries = await invoke<DirEntry[]>('fs_list_dir', { rel });
			this.children.set(rel, entries);
			if (!rel) clientLog('info', `explorer: ${entries.length} entries at workspace root`);
		} catch (e) {
			this.error = String(e);
		}
	}

	async toggle(rel: string) {
		if (this.expanded.has(rel)) this.expanded.delete(rel);
		else {
			this.expanded.add(rel);
			if (!this.children.has(rel)) await this.load(rel);
		}
	}

	/** Visible rows in display order, like VS Code's flattened tree. */
	rows(): Row[] {
		const out: Row[] = [];
		const walk = (rel: string, depth: number) => {
			for (const e of this.children.get(rel) ?? []) {
				const expanded = e.is_dir && this.expanded.has(e.rel);
				out.push({ ...e, depth, expanded });
				if (expanded) walk(e.rel, depth + 1);
			}
		};
		walk('', 0);
		return out;
	}
}

export const explorer = new Explorer();
