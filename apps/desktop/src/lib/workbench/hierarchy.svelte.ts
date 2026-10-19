// Call and type hierarchy (VS Code: the built-in references-view extension's Calls and Types views,
// what ⇧⌥H opens): the item at the cursor as the root, children loaded level by level from
// callHierarchy/incomingCalls|outgoingCalls or typeHierarchy/supertypes|subtypes, in a side bar
// section of the Explorer.

import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { defaultDirection, hierarchyRows, nodeLocation, type HierarchyDirection, type HierarchyKind, type HierarchyNode } from './hierarchyModel';
import { t } from '#lib/i18n/index.ts';
import { editors } from './editors.svelte';
import { layout } from './layout.svelte';
import { notifications } from './notifications.svelte';
import { status } from './status.svelte';

class Hierarchy {
	kind = $state<HierarchyKind | null>(null);
	direction = $state<HierarchyDirection>('incoming');
	roots = $state<HierarchyNode[]>([]);
	/** The server that answered (its key), to ask for children. */
	#key = '';
	#seq = 0;
	/** Where it was opened, for Refresh. */
	#origin: { rel: string; line: number; column: number } | null = null;
	readonly rows = $derived(hierarchyRows(this.roots));
	readonly title = $derived(this.kind === 'type' ? t('language.hierarchy.types') : t('language.hierarchy.calls'));

	/** Show Call/Type Hierarchy at the active editor's cursor. */
	async show(kind: HierarchyKind, direction: HierarchyDirection = defaultDirection(kind)) {
		const rel = editors.active;
		if (!rel) return;
		this.#origin = { rel, line: editors.cursor.line, column: editors.cursor.column };
		await this.#load(kind, direction);
	}

	async #load(kind: HierarchyKind, direction: HierarchyDirection) {
		const origin = this.#origin;
		if (!origin) return;
		const feature = kind === 'call' ? t('language.hierarchy.calls') : t('language.hierarchy.types');
		const seq = ++this.#seq;
		let roots;
		try {
			roots = await lsp.hierarchyRoots(kind, origin.rel, origin.line, origin.column);
		} catch (e) {
			return notifications.error(t('language.hierarchy.failed', { feature, error: e instanceof Error ? e.message : String(e) }));
		}
		if (seq !== this.#seq) return;
		if (!roots) return status.flash(t('language.hierarchy.unsupported', { feature }));
		if (!roots.items.length) return status.flash(kind === 'call' ? t('language.hierarchy.noCallHierarchy') : t('language.hierarchy.noTypeHierarchy'));
		this.#key = roots.key;
		this.kind = kind;
		this.direction = direction;
		this.roots = roots.items.map((item, i) => ({ id: `${i}`, item, ranges: [], children: null, loading: false, expanded: false }));
		layout.showView('explorer');
		layout.sidebarVisible = true;
		// The root opens at once, like the references view.
		if (this.roots.length === 1) await this.toggle(this.roots[0]);
	}

	async toggle(node: HierarchyNode) {
		if (node.expanded) {
			node.expanded = false;
			this.roots = [...this.roots];
			return;
		}
		node.expanded = true;
		if (node.children === null) {
			node.loading = true;
			this.roots = [...this.roots];
			const seq = this.#seq;
			const direction = this.direction;
			try {
				const children = await lsp.hierarchyChildren(this.#key, direction, node.item);
				if (seq !== this.#seq) return;
				node.children = children.map((c, i) => ({ id: `${node.id}/${i}`, item: c.item, ranges: c.ranges, children: null, loading: false, expanded: false }));
			} catch (e) {
				node.children = [];
				notifications.error(t('language.hierarchy.failed', { feature: this.title, error: e instanceof Error ? e.message : String(e) }));
			}
			node.loading = false;
		}
		this.roots = [...this.roots];
	}

	/** Show Incoming/Outgoing Calls, Show Supertypes/Subtypes on the same root. */
	async setDirection(direction: HierarchyDirection) {
		if (!this.kind) return;
		await this.#load(this.kind, direction);
	}

	refresh() {
		if (this.kind) void this.#load(this.kind, this.direction);
	}

	clear() {
		this.#seq++;
		this.kind = null;
		this.roots = [];
	}

	open(node: HierarchyNode, focus = true) {
		const loc = nodeLocation(node, this.direction);
		const rel = lsp.relOf(loc.uri);
		if (rel === null) return notifications.warn(t('tools.lsp.outsideWorkspace', { path: loc.uri }));
		const { line, character } = loc.range.start;
		if (focus) editors.openFromCodeNavigation(rel, line + 1, character + 1);
		else editors.open(rel, { preview: true, reveal: { line: line + 1, column: character + 1, focus: false } });
	}
}

export const hierarchy = new Hierarchy();
