// The chat tips' state (VS Code's chatTipService): the tip shown, the ones dismissed (kept in this
// browser profile, like VS Code's application storage), what the user already did (so a tip about
// it stops showing), and "hidden for this session". `chat.tips.enabled` turns them off.
// Palette commands (registerTipCommands):
//   workbench.action.chat.generateAgentInstructions   Generate Agent Instructions (the panel sends it)
//   workbench.action.chat.resetDismissedTips          Reset Dismissed Tips
//   workbench.action.chat.nextTip / previousTip       Next / Previous Tip
//   workbench.action.chat.disableTips                 Disable Tips

import { commands } from '#lib/workbench/commands.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { shownTip, stepTip, type TipContext, type TipDef } from './chatTips.ts';

const DISMISSED = 'kingu.chat.tips.dismissed';
const USED = 'kingu.chat.tips.used';

function readList(key: string): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? '[]');
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

function writeList(key: string, list: readonly string[]) {
	try {
		localStorage.setItem(key, JSON.stringify(list));
	} catch {
		// Private storage: forgotten after this session.
	}
}

class ChatTips {
	dismissed = $state<string[]>(readList(DISMISSED));
	used = $state<string[]>(readList(USED));
	hiddenForSession = $state(false);
	/** The tip on screen, kept while it may still show. */
	shownId = $state<string | null>(null);
	/** Bumped by Generate Agent Instructions from the palette: the panel sends it. */
	generate = $state(0);

	get enabled(): boolean {
		return settings.get<boolean>('chat.tips.enabled') !== false;
	}

	get dismissedSet(): ReadonlySet<string> {
		return new Set(this.dismissed);
	}

	/** The tip to show for `ctx` (no state change; `keep` records it). */
	current(ctx: TipContext): TipDef | undefined {
		return shownTip(this.shownId, ctx, this.dismissedSet);
	}

	keep(tip: TipDef | undefined) {
		const id = tip?.id ?? null;
		if (id !== this.shownId) this.shownId = id;
	}

	/** The user did something a tip teaches (a mode picked, a file attached, /fork...). */
	record(what: string) {
		if (this.used.includes(what)) return;
		this.used = [...this.used, what];
		writeList(USED, this.used);
	}

	step(dir: 1 | -1, ctx: TipContext) {
		const next = stepTip(this.shownId, dir, ctx, this.dismissedSet);
		if (next) this.shownId = next.id;
	}

	/** Dismiss tip: never again; the next one shows. */
	dismiss(ctx: TipContext) {
		const id = this.shownId;
		if (!id) return;
		const next = stepTip(id, 1, ctx, this.dismissedSet);
		this.dismissed = [...this.dismissed, id];
		writeList(DISMISSED, this.dismissed);
		this.shownId = next && next.id !== id ? next.id : null;
	}

	disable() {
		void settings.set('chat.tips.enabled', false, 'user');
	}

	reset() {
		this.dismissed = [];
		this.hiddenForSession = false;
		writeList(DISMISSED, []);
		status.flash(t('chatTips.reset'), 4000);
	}
}

export const chatTips = new ChatTips();

/** Signals the panel answers (it holds the chat's state the tips need). */
class TipSignals {
	next = $state(0);
	previous = $state(0);
}
export const tipSignals = new TipSignals();

export function registerTipCommands(): () => void {
	const show = () => {
		if (appMode.isAgents) appMode.setMode('workbench');
		layout.auxVisible = true;
	};
	const off = [
		commands.register({
			id: 'workbench.action.chat.generateAgentInstructions',
			title: 'Generate Agent Instructions',
			category: 'Chat',
			run: () => {
				show();
				chatTips.generate++;
			}
		}),
		commands.register({ id: 'workbench.action.chat.resetDismissedTips', title: 'Reset Dismissed Tips', category: 'Chat', run: () => chatTips.reset() }),
		commands.register({ id: 'workbench.action.chat.nextTip', title: 'Next Tip', category: 'Chat', when: () => chatTips.enabled, run: () => void tipSignals.next++ }),
		commands.register({ id: 'workbench.action.chat.previousTip', title: 'Previous Tip', category: 'Chat', when: () => chatTips.enabled, run: () => void tipSignals.previous++ }),
		commands.register({ id: 'workbench.action.chat.disableTips', title: 'Disable Tips', category: 'Chat', when: () => chatTips.enabled, run: () => chatTips.disable() })
	];
	return () => off.forEach((f) => f());
}
