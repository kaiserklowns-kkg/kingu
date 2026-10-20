/// <reference types="bun" />
// The menu model against the real command registrations. Commands register inside Svelte
// components (runes), so their ids and keybindings are read from the source of every
// `commands.register({ … })` call instead of by mounting the workbench.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMenuEcho, keyLabel, keyOf, MENU_ECHO_MS, toAccelerator } from './keys';
import { EDITOR_ACTIONS, flattenItems, itemStates, MENUS, menuCommands, parseMnemonic, RECENT_PREFIX, resolveMenubar, ROLES, structureKey, type MenuContext, type MenuItem, type MenuNode } from './menus';

const LIB = join(import.meta.dir, '..');

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.(ts|svelte)$/.test(name) && !name.includes('.test.') ? [path] : [];
	});
}

/** `terminalOnly`: its key acts only while a terminal has focus (`keyWhen`), where Monaco's menu keys do not apply. */
type Registered = { id: string; key?: string; mac?: string; terminalOnly?: boolean };

/** Every `commands.register({ id: '…', … key: '…', mac: '…', … run` in src/lib. */
function registeredCommands(): Map<string, Registered> {
	const out = new Map<string, Registered>();
	for (const file of sources(LIB)) {
		const text = readFileSync(file, 'utf8');
		for (const m of text.matchAll(/commands\.register\(\{([\s\S]*?)\brun:/g)) {
			const body = m[1];
			const field = (name: string) => body.match(new RegExp(`\\b${name}: '((?:[^'\\\\]|\\\\.)*)'`))?.[1]?.replace(/\\\\/g, '\\');
			const id = field('id');
			if (id) out.set(id, { id, key: field('key'), mac: field('mac'), ...(/keyWhen: (panelTerminalFocus,|\(\) => focusedTerminal\(\) !== null,)/.test(body) ? { terminalOnly: true } : {}) });
		}
	}
	return out;
}

const registered = registeredCommands();
// Monaco's actions are registered in a loop over EDITOR_ACTIONS (EditorPart.svelte).
const editorPart = readFileSync(join(import.meta.dir, 'EditorPart.svelte'), 'utf8');
const isRegistered = (id: string) => registered.has(id) || (id in EDITOR_ACTIONS && editorPart.includes('Object.entries(EDITOR_ACTIONS)'));

function context(mac: boolean, over: Partial<MenuContext> = {}): MenuContext {
	return {
		mac,
		keyOf: (id) => {
			const r = registered.get(id);
			return r ? keyOf(r, mac) : undefined;
		},
		enabled: () => true,
		checked: () => false,
		recent: [],
		...over
	};
}

/** Commands VS Code itself binds to one key, told apart by when they are enabled (F11: Step Into
 * while the debugger is stopped, else Toggle Full Screen; Kingu gives full screen the lower weight). */
const SHARED_KEYS = new Set(['workbench.action.debug.stepInto workbench.action.toggleFullScreen']);

function walk(items: MenuItem[], visit: (i: MenuItem) => void) {
	for (const i of items) {
		visit(i);
		if ('submenu' in i) walk(i.items, visit);
	}
}

describe('menu model', () => {
	test('finds the workbench registrations (sanity check of the source scan)', () => {
		expect(registered.get('workbench.action.quickOpen')?.key).toBe('cmd+p');
		expect(registered.get('workbench.action.splitEditor')?.key).toBe('cmd+\\');
		expect(registered.get('workbench.action.navigateBack')).toEqual({ id: 'workbench.action.navigateBack', key: 'alt+left', mac: 'ctrl+-' });
		expect(registered.size).toBeGreaterThan(40);
	});

	test('every item runs a registered command or a predefined role', () => {
		const missing = menuCommands().filter((id) => !isRegistered(id));
		expect(missing).toEqual([]);
		const roleNames = Object.keys(ROLES);
		for (const menu of MENUS) walk(menu.items, (i) => 'role' in i && expect(roleNames).toContain(i.role));
	});

	test('every role is one the Rust menu builds', () => {
		const rust = readFileSync(join(import.meta.dir, '../../../src-tauri/src/menu.rs'), 'utf8');
		const variants = rust.match(/pub enum Role \{([^}]*)\}/)![1];
		for (const role of Object.keys(ROLES)) expect(variants).toContain(role[0].toUpperCase() + role.slice(1) + ',');
	});

	for (const mac of [true, false]) {
		const platform = mac ? 'macOS' : 'Windows/Linux';

		test(`${platform}: no two items share an accelerator`, () => {
			const seen = new Map<string, string>();
			const dupes: string[] = [];
			const visit = (nodes: MenuNode[]) => {
				for (const n of nodes) {
					if (n.type === 'submenu') visit(n.items);
					if ((n.type !== 'item' && n.type !== 'role') || !n.keyLabel) continue;
					const name = n.type === 'item' ? n.id : n.role;
					const other = seen.get(n.keyLabel);
					// One command listed in two menus (New Task in File and Agents) shares its key legitimately.
					if (other && other !== name && !SHARED_KEYS.has([other, name].sort().join(' '))) dupes.push(`${n.keyLabel}: ${other} / ${name}`);
					seen.set(n.keyLabel, name);
				}
			};
			visit(resolveMenubar(context(mac)));
			expect(dupes).toEqual([]);
		});

		test(`${platform}: keys the menu owns (Monaco's) collide with no workbench keybinding`, () => {
			const workbenchKeys = new Map([...registered.values()].flatMap((r) => (keyOf(r, mac) && !r.terminalOnly ? [[keyLabel(keyOf(r, mac)!, mac), r.id] as const] : [])));
			for (const menu of MENUS)
				walk(menu.items, (i) => {
					if (!('command' in i)) return;
					const own = keyOf(i, mac);
					if (own) expect([i.command, keyLabel(own, mac), workbenchKeys.get(keyLabel(own, mac))]).toEqual([i.command, keyLabel(own, mac), undefined]);
				});
		});

		test(`${platform}: accelerators are in the syntax the native menu parses`, () => {
			const items = flattenItems(resolveMenubar(context(mac)));
			const accelerators = items.flatMap((i) => (i.accelerator ? [i.accelerator] : []));
			expect(accelerators.length).toBeGreaterThan(15);
			for (const a of accelerators) expect(a).toMatch(/^((Ctrl|Alt|Shift|Cmd)\+)*([A-Z0-9]|F\d{1,2}|Backquote|Backslash|Comma|Period|Equal|Minus|Slash|Semicolon|Quote|BracketLeft|BracketRight|Arrow(Left|Right|Up|Down)|Page(Up|Down))$/);
			// Every item with a single-chord keybinding gets an accelerator; two-part chords only a label.
			for (const i of items) if (i.keyLabel && !i.keyLabel.includes(' ')) expect([i.id, i.accelerator]).toEqual([i.id, expect.any(String)]);
		});

		test(`${platform}: labels are set, without mnemonic markers or stray separators`, () => {
			const check = (nodes: MenuNode[]) => {
				expect(nodes[0]?.type).not.toBe('separator');
				expect(nodes[nodes.length - 1]?.type).not.toBe('separator');
				nodes.forEach((n, i) => {
					if (n.type === 'separator') expect(nodes[i - 1].type).not.toBe('separator');
					if (n.type === 'separator') return;
					expect(n.text.trim().length).toBeGreaterThan(0);
					expect(n.text).not.toContain('&');
					if (n.type === 'submenu') check(n.items);
				});
			};
			const bar = resolveMenubar(context(mac));
			check(bar);
			const tops = bar.map((m) => m.text);
			expect(tops).toEqual(mac ? ['Kingu', 'File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Agents', 'Terminal', 'Window', 'Help'] : ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Agents', 'Terminal', 'Help']);
		});
	}

	test('Windows/Linux top-level mnemonics are unique', () => {
		const letters = resolveMenubar(context(false)).map((m) => m.text[m.mnemonic!].toLowerCase());
		expect(new Set(letters).size).toBe(letters.length);
		expect(letters).toEqual(['f', 'e', 's', 'v', 'g', 'r', 'a', 't', 'h']);
	});

	test('macOS keeps About/Settings/Quit in the app menu and Edit uses native roles', () => {
		const bar = resolveMenubar(context(true));
		const app = bar[0].items;
		expect(app.map((n) => (n.type === 'role' ? n.role : n.type === 'item' ? n.id : n.type))).toEqual([
			'about',
			'separator',
			'workbench.action.openSettings',
			'separator',
			'services',
			'separator',
			'hide',
			'hideOthers',
			'showAll',
			'separator',
			'quit'
		]);
		const edit = bar.find((m) => m.id === 'edit')!.items;
		expect(edit.filter((n) => n.type === 'role').map((n) => n.type === 'role' && n.role)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste']);
		const items = flattenItems(bar);
		expect(items.find((i) => i.id === 'workbench.action.showCommands')?.accelerator).toBe('Shift+Cmd+P');
		expect(items.find((i) => i.id === 'workbench.action.toggleAuxiliaryBar')?.accelerator).toBe('Alt+Cmd+B');
		expect(items.find((i) => i.id === 'workbench.action.navigateForward')?.accelerator).toBe('Ctrl+Shift+Minus');
		expect(items.find((i) => i.id === 'actions.find')?.accelerator).toBe('Cmd+F');
		// Two-part chord: shown in the label only.
		const theme = items.find((i) => i.id === 'workbench.action.selectTheme')!;
		expect([theme.accelerator, theme.keyLabel]).toEqual([undefined, '⌘K ⌘T']);
		expect(items.some((i) => i.id === 'workbench.action.quit')).toBe(false);
	});

	test('toggles carry their checked state, items their enablement', () => {
		const bar = resolveMenubar(context(true, { checked: (id) => id === 'workbench.action.togglePanel', enabled: (id) => id !== 'workbench.action.files.save' }));
		const states = itemStates(bar);
		expect(states.get('workbench.action.togglePanel')).toEqual({ enabled: true, checked: true });
		expect(states.get('workbench.action.toggleSidebarVisibility')).toEqual({ enabled: true, checked: false });
		expect(states.get('workbench.action.files.save')).toEqual({ enabled: false, checked: undefined });
		// State changes alone do not change the structure (no native rebuild).
		expect(structureKey(bar)).toBe(structureKey(resolveMenubar(context(true))));
	});

	test('⌘⇧A / Ctrl+Shift+A toggles Agents mode; Show Agents has no key any more', () => {
		expect(registered.get('workbench.action.toggleAgentsMode')?.key).toBe('cmd+shift+a');
		expect(registered.get('kingu.agents.show')?.key).toBeUndefined();
		for (const mac of [true, false]) {
			const holders = [...registered.values()].filter((r) => {
				const k = keyOf(r, mac);
				return k === 'cmd+shift+a' || k === 'ctrl+shift+a';
			});
			expect(holders.map((r) => r.id)).toEqual(['workbench.action.toggleAgentsMode']);
		}
		// The ActivityBar no longer advertises the old chord.
		expect(readFileSync(join(import.meta.dir, 'ActivityBar.svelte'), 'utf8')).not.toContain('ctrl+shift+a');
	});

	test('Agents menu: "Open in Agents" reads "Open in Editor" in Agents mode, without a check mark', () => {
		const item = (checked: boolean, mac: boolean) => {
			const agents = resolveMenubar(context(mac, { checked: (id) => checked && id === 'workbench.action.toggleAgentsMode' })).find((m) => m.id === 'agents')!;
			return flattenItems(agents.items).find((i) => i.id === 'workbench.action.toggleAgentsMode')!;
		};
		expect(item(false, true)).toMatchObject({ text: 'Open in Agents', accelerator: 'Shift+Cmd+A', keyLabel: '⇧⌘A' });
		expect(item(true, true)).toMatchObject({ text: 'Open in Editor', accelerator: 'Shift+Cmd+A' });
		expect(item(true, true).checked).toBeUndefined();
		expect(item(false, false)).toMatchObject({ accelerator: 'Ctrl+Shift+A', keyLabel: 'Ctrl+Shift+A' });
		// The label change rebuilds the native menu.
		expect(structureKey(resolveMenubar(context(true, { checked: (id) => id === 'workbench.action.toggleAgentsMode' })))).not.toBe(structureKey(resolveMenubar(context(true))));
	});

	test('title bar commands are registered (Customize Layout, context menu toggles, Agents mode)', () => {
		const src = readFileSync(join(import.meta.dir, 'titlebar.ts'), 'utf8');
		const toggles = [...src.matchAll(/command: '([^']+)'/g)].map((m) => m[1]);
		expect(toggles.length).toBe(5);
		const layoutControls = readFileSync(join(import.meta.dir, 'layoutControls.svelte.ts'), 'utf8');
		expect(layoutControls).toContain('TITLE_BAR_TOGGLES.map((t) =>\n\t\t\tcommands.register({ id: t.command');
		for (const id of ['workbench.action.customizeLayout', 'kingu.agents.openInAgents', 'kingu.agents.openInEditor', 'kingu.agents.pickSession', 'kingu.agents.newSession'])
			expect([id, registered.has(id)]).toEqual([id, true]);
	});

	test('Open Recent lists recent folders, More… and Clear', () => {
		const recent = [
			{ path: '/Users/me/code/kingu', label: 'kingu', detail: '~/code' },
			{ path: '/tmp/x', label: 'x', detail: '/tmp' }
		];
		const sub = (ctx: MenuContext) => {
			const file = resolveMenubar(ctx).find((m) => m.id === 'file')!;
			const node = file.items.find((n) => n.type === 'submenu' && n.id === 'openRecent');
			return node?.type === 'submenu' ? node.items : [];
		};
		const items = sub(context(true, { recent }));
		expect(items.map((n) => (n.type === 'item' ? `${n.id}|${n.text}|${n.enabled}` : n.type))).toEqual([
			`${RECENT_PREFIX}/Users/me/code/kingu|kingu  ~/code|true`,
			`${RECENT_PREFIX}/tmp/x|x  /tmp|true`,
			'separator',
			'workbench.action.openRecent|More...|true',
			'separator',
			'workbench.action.clearRecentFiles|Clear Recently Opened|true'
		]);
		const empty = sub(context(true));
		expect(empty[0].type).toBe('item');
		expect(empty.find((n) => n.type === 'item' && n.id === 'workbench.action.clearRecentFiles')).toMatchObject({ enabled: false });
		// A new recent folder changes the structure: the native menu is rebuilt.
		expect(structureKey(resolveMenubar(context(true, { recent })))).not.toBe(structureKey(resolveMenubar(context(true))));
	});

	test('parseMnemonic', () => {
		expect(parseMnemonic('&File')).toEqual({ text: 'File', mnemonic: 'f', index: 0 });
		expect(parseMnemonic('Save &As')).toEqual({ text: 'Save As', mnemonic: 'a', index: 5 });
		expect(parseMnemonic('Fish && Chips')).toEqual({ text: 'Fish & Chips', mnemonic: null, index: -1 });
		expect(parseMnemonic('Kingu')).toEqual({ text: 'Kingu', mnemonic: null, index: -1 });
	});
});

describe('accelerators and keyboard/menu ownership', () => {
	test('toAccelerator converts keybindings to native menu accelerators', () => {
		expect(toAccelerator('cmd+shift+p', true)).toBe('Shift+Cmd+P');
		expect(toAccelerator('cmd+shift+p', false)).toBe('Ctrl+Shift+P');
		expect(toAccelerator('ctrl+`', true)).toBe('Ctrl+Backquote');
		expect(toAccelerator('cmd+,', true)).toBe('Cmd+Comma');
		expect(toAccelerator('cmd+\\', true)).toBe('Cmd+Backslash');
		expect(toAccelerator('f12', true)).toBe('F12');
		expect(toAccelerator('ctrl+shift+cmd+right', true)).toBe('Ctrl+Shift+Cmd+ArrowRight');
		expect(toAccelerator('cmd+k cmd+t', true)).toBeNull();
	});

	test('keyOf prefers the macOS binding on macOS only', () => {
		expect(keyOf({ key: 'alt+left', mac: 'ctrl+-' }, true)).toBe('ctrl+-');
		expect(keyOf({ key: 'alt+left', mac: 'ctrl+-' }, false)).toBe('alt+left');
		expect(keyOf({ key: 'cmd+s' }, true)).toBe('cmd+s');
		expect(keyOf({}, true)).toBeUndefined();
	});

	test('a menu event right behind the same keybinding is an echo and is dropped', () => {
		const last = { id: 'workbench.action.files.save', at: 1000 };
		expect(isMenuEcho('workbench.action.files.save', 1005, last)).toBe(true);
		expect(isMenuEcho('workbench.action.files.save', 1000 + MENU_ECHO_MS, last)).toBe(false);
		expect(isMenuEcho('workbench.action.files.saveAll', 1005, last)).toBe(false);
		expect(isMenuEcho('workbench.action.files.save', 1005, null)).toBe(false);
	});
});
