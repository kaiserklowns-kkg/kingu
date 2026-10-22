// Command registry and keybindings (VS Code: registerAction2 → CommandsRegistry,
// MenuId.CommandPalette when `f1`, KeybindingsRegistry). One window-level key listener.

import { eventLabel as chordLabel, isMac, isMenuEcho, isModifierKey, keyOf as defaultKeyOf, matches, parseChord, splitKeybinding } from './keys';
import { keybindings } from './keybindings.svelte';
import { keysFor, liveKeys, ownedKeys, whenKey, type KeyScope } from './keybindingsModel';
import { evaluateWhen } from './contextKey';
import { currentContext } from './contextKeys.svelte';
import { appMode } from './mode.svelte';
import { status } from './status.svelte';
import { settings } from '#lib/settings/settings.svelte.ts';
import { terminalStartsChord, workbenchTakesKey } from '#lib/terminal/behaviour.ts';
import { t } from '#lib/i18n/index.ts';

type Keyed = { id: string; key?: string; mac?: string; scope?: KeyScope };

/** Every key bound to `cmd` on this platform: keybindings.json's first, then the default unless removed. */
export function keysOf(cmd: Keyed, mac = isMac): string[] {
	return keysFor(cmd.id, defaultKeyOf(cmd, mac), keybindings.user);
}

/** The layout whose keys are live: Orca's in the Agents layout, VS Code's in the IDE. */
export const keyLayout = (): KeyScope => (appMode.isAgents ? 'agents' : 'ide');

/** The keys that run `cmd` in `layout` (keybindingsModel.liveKeys). */
export function liveKeysOf(cmd: Keyed, layout = keyLayout(), mac = isMac): string[] {
	const owned = mac === isMac ? commands.owned[layout] : ownedKeys(commands.all.map((c) => ({ scope: c.scope, keys: keysOf(c, mac) })), layout);
	return liveKeys(keysOf(cmd, mac), cmd.scope, layout, owned, keybindings.user.added.get(cmd.id));
}

/** The key menus, the palette and tooltips show for `cmd` (the user's own wins), else the key
 * of whoever owns it (Monaco for editor actions). */
export function keyOf(cmd: Keyed & { ownerKey?: () => string | undefined }, mac = isMac): string | undefined {
	return liveKeysOf(cmd, keyLayout(), mac)[0] ?? (keybindings.user.removed.get(cmd.id) === 'all' ? undefined : cmd.ownerKey?.());
}

export type Command = {
	id: string;
	title: string;
	category?: string;
	/** VS Code-style chord, e.g. `cmd+shift+p`, `ctrl+\``. `cmd` maps to Ctrl off macOS. */
	key?: string;
	/** macOS keybinding when it differs from `key` (VS Code's `mac:`), e.g. Go Back `ctrl+-` vs `alt+left`. */
	mac?: string;
	/** Listed in the command palette (VS Code's `f1: true`). Defaults to true. */
	palette?: boolean;
	when?: () => boolean;
	/** Extra condition for the keybinding only (VS Code's keybinding `when`, e.g. not in the
	 * terminal), so menus and the palette still run the command. */
	keyWhen?: () => boolean;
	/** The layout this keybinding belongs to (keybindingsModel.liveKeys): `agents` for Orca's keys,
	 * which win over an unscoped command's default there. Menus and the palette ignore it. */
	scope?: KeyScope;
	/** A key bound outside this registry (Monaco's own keybinding of an editor action), for display only. */
	ownerKey?: () => string | undefined;
	/** A default key of a higher weight wins over one of a lower weight on the same key while both
	 * are enabled (VS Code's KeybindingWeight), e.g. a review key over New File. Defaults to 0. */
	weight?: number;
	/** `args`: a keybindings.json entry's arguments (VS Code's command `args`), unchecked JSON, else
	 * undefined. Typed `never` so a command whose own optional parameter means something else
	 * still registers; a command that reads `args` validates it. */
	run: (args?: never) => unknown;
};

/** Runs a command with keybindings.json arguments (see `Command.run`). */
const runWith = (cmd: Command, args: unknown) => (cmd.run as (args?: unknown) => unknown)(args);

class Commands {
	/** Raw, not a deep proxy: `register`'s unregister compares the caller's own object, which a
	 * proxied list would never hold (the command stayed registered and Svelte warned each time). */
	all = $state.raw<Command[]>([]);
	/** The keys the commands scoped to each layout own there. */
	owned = $derived.by(() => {
		const entries = this.all.map((c) => ({ scope: c.scope, keys: c.scope ? keysOf(c) : [] }));
		return { ide: ownedKeys(entries, 'ide'), agents: ownedKeys(entries, 'agents') };
	});
	/** The last command run by a keybinding (see MENU_ECHO_MS in keys.ts). */
	lastKeyRun: { id: string; at: number } | null = null;

	get(id: string): Command | undefined {
		return this.all.find((c) => c.id === id);
	}

	enabled(id: string): boolean {
		const cmd = this.get(id);
		return !!cmd && (!cmd.when || cmd.when());
	}

	/** A click on a native or in-window menu item. */
	async runFromMenu(id: string) {
		if (isMenuEcho(id, performance.now(), this.lastKeyRun)) return;
		await this.run(id);
	}

	register(cmd: Command): () => void {
		this.all = [...this.all.filter((c) => c.id !== cmd.id), cmd];
		return () => (this.all = this.all.filter((c) => c !== cmd));
	}

	async run(id: string, args?: unknown) {
		const cmd = this.all.find((c) => c.id === id);
		if (cmd && (!cmd.when || cmd.when())) await runWith(cmd, args);
	}

	paletteItems() {
		return this.all.filter((c) => c.palette !== false && (!c.when || c.when()));
	}
}

export const commands = new Commands();

/**
 * Capture phase, so workbench chords win over Monaco and xterm like VS Code's keybinding service.
 * Two-part chords (`cmd+k cmd+t`) wait for the second key after the first. Inside Monaco both keys
 * still reach the editor, so its own `⌘K …` chords keep working.
 */
export function installKeybindings(): () => void {
	let pending: KeyboardEvent | null = null;
	type Binding = { cmd: Command; parts: string[]; user: boolean; when?: string; args?: unknown };
	let ctx: ReturnType<typeof currentContext> | null = null;
	/** keybindings.json's `when` on top of the command's own conditions; the context is read once per keypress. */
	const enabled = (b: Binding) => (!b.cmd.when || b.cmd.when()) && (!b.cmd.keyWhen || b.cmd.keyWhen()) && (!b.when || evaluateWhen(b.when, (ctx ??= currentContext())));
	/** Every (command, chord parts) pair; user keybindings first, so they win over a default on the same key. */
	const bindings = (): Binding[] => {
		const { added, when, args } = keybindings.user;
		const all = commands.all.flatMap((cmd) =>
			liveKeysOf(cmd).map((key) => {
				const user = added.get(cmd.id)?.includes(key) ?? false;
				return { cmd, parts: splitKeybinding(key), user, when: user ? when.get(whenKey(cmd.id, key)) : undefined, args: user ? args.get(whenKey(cmd.id, key)) : undefined };
			})
		);
		const byWeight = (list: Binding[]) => list.sort((a, b) => (b.cmd.weight ?? 0) - (a.cmd.weight ?? 0));
		return [...byWeight(all.filter((b) => b.user)), ...byWeight(all.filter((b) => !b.user))];
	};
	const runByKey = (b: Binding) => {
		commands.lastKeyRun = { id: b.cmd.id, at: performance.now() };
		void runWith(b.cmd, b.args);
	};
	const consume = (e: KeyboardEvent, inEditor: boolean) => {
		if (inEditor) return;
		e.preventDefault();
		e.stopPropagation();
	};
	const onKey = (e: KeyboardEvent) => {
		if (isModifierKey(e)) return;
		// The Keyboard Shortcuts editor is recording a keybinding: the keys are its input, not commands.
		if (e.target instanceof Element && e.target.closest('[data-keybinding-capture]')) {
			pending = null;
			return;
		}
		ctx = null;
		const inEditor = e.target instanceof Element && e.target.closest('.monaco-editor') !== null;
		// A focused terminal keeps the keys terminal.integrated.sendKeybindingsToShell / commandsToSkipShell give the shell.
		const inTerminal = e.target instanceof Element && e.target.closest('.xterm') !== null;
		const takes = (cmd: Command) =>
			!inTerminal ||
			workbenchTakesKey(cmd.id, e.metaKey, settings.get<boolean>('terminal.integrated.sendKeybindingsToShell'), settings.get<string[]>('terminal.integrated.commandsToSkipShell'));
		if (pending) {
			const first = pending;
			pending = null;
			for (const b of bindings()) {
				const p = b.parts;
				if (p.length === 2 && matches(parseChord(p[0]), first) && matches(parseChord(p[1]), e) && enabled(b)) {
					consume(e, inEditor);
					status.flash('', 0);
					runByKey(b);
					return;
				}
			}
			if (!inEditor) status.flash(t('workbench.commands.noChord', { chord: `${chordLabel(first)}, ${chordLabel(e)}` }));
			consume(e, inEditor);
			return;
		}
		const all = bindings();
		for (const b of all) {
			if (b.parts.length !== 1 || !matches(parseChord(b.parts[0]), e) || !enabled(b) || !takes(b.cmd)) continue;
			e.preventDefault();
			e.stopPropagation();
			runByKey(b);
			return;
		}
		// terminal.integrated.allowChords: off, a chord's first key goes to the shell instead.
		const chordsHere = !inTerminal || terminalStartsChord(settings.get<boolean>('terminal.integrated.allowChords'), e.key);
		const startsChord = chordsHere && all.some((b) => b.parts.length === 2 && matches(parseChord(b.parts[0]), e) && enabled(b) && takes(b.cmd));
		if (startsChord) {
			pending = e;
			consume(e, inEditor);
			status.flash(t('workbench.commands.chordPending', { key: chordLabel(e) }));
		}
	};
	window.addEventListener('keydown', onKey, true);
	return () => window.removeEventListener('keydown', onKey, true);
}
