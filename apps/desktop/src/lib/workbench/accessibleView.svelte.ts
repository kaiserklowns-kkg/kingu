// The Accessible View (⌥F2) and Accessibility Help (⌥F1), VS Code's AccessibleViewService. Views
// that own content register a provider for the elements they render (the chat list); hovers,
// notifications and terminals are found here. The text itself is built in accessibleView.ts.

import { t } from '#lib/i18n/index.ts';
import { focusedTerminal } from '#lib/terminal/registry.ts';
import { commands, keyOf } from './commands.svelte';
import { accessibleViewContentOf, chatItems, helpContextOf, helpText, notificationText, stepIndex, terminalText, tidyText, type AccessibleContent, type ChatTurnLike } from './accessibleView';
import { screenReaderMode } from './accessibilitySignals.svelte';
import { keyLabel } from './keys';
import { notifications } from './notifications.svelte';

export type AccessibleProvider = {
	/** Whether the focused element belongs to this provider's view. */
	owns: (el: Element) => boolean;
	content: (el: Element) => AccessibleContent | null;
};

/** The provider of a chat list: one item per turn, the focused turn (else the last) first. */
export function chatProvider(root: () => HTMLElement | undefined, turns: () => ChatTurnLike[]): AccessibleProvider {
	return {
		owns: (el) => !!root()?.contains(el),
		content: (el) => {
			const items = chatItems(turns());
			if (!items.length) return null;
			const at = Number(el.closest('[data-turn-index]')?.getAttribute('data-turn-index') ?? NaN);
			return { kind: 'chat', items, index: Number.isFinite(at) ? Math.min(at, items.length - 1) : items.length - 1 };
		}
	};
}

/** A visible Monaco hover (the editor's, or a widget's). */
function visibleHover(): string {
	for (const el of document.querySelectorAll<HTMLElement>('.monaco-hover')) {
		if (el.classList.contains('hidden') || el.offsetParent === null) continue;
		const text = tidyText(el.innerText);
		if (text) return text;
	}
	return '';
}

class AccessibleView {
	open = $state(false);
	mode = $state<'view' | 'help'>('view');
	content = $state<AccessibleContent | null>(null);
	help = $state('');
	#providers: AccessibleProvider[] = [];
	#returnFocus: HTMLElement | null = null;

	registerProvider(p: AccessibleProvider): () => void {
		this.#providers.push(p);
		return () => (this.#providers = this.#providers.filter((x) => x !== p));
	}

	/** What the Accessible View shows for the focused element, if anything. */
	resolve(el: Element | null): AccessibleContent | null {
		const hover = visibleHover();
		if (hover) return { kind: 'hover', items: [hover], index: 0 };
		if (!el) return null;
		const note = el.closest('[data-notification-id]');
		if (note) {
			const id = Number(note.getAttribute('data-notification-id'));
			const items = notifications.items;
			const index = Math.max(0, items.findIndex((n) => n.id === id));
			return items.length ? { kind: 'notification', items: items.map(notificationText), index } : null;
		}
		const term = focusedTerminal();
		if (term?.lines) return { kind: 'terminal', items: [terminalText(term.lines())], index: 0 };
		return accessibleViewContentOf(this.#providers, el);
	}

	#remember() {
		if (!this.open) this.#returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}

	show() {
		const content = this.resolve(document.activeElement);
		this.#remember();
		this.mode = 'view';
		this.content = content;
		this.help = content ? '' : t('accessibility.view.nothing');
		this.open = true;
	}

	showHelp() {
		const el = document.activeElement;
		const context = helpContextOf({
			notification: !!el?.closest('[data-notification-id]'),
			notebook: !!el?.closest('[data-notebook]'),
			terminal: focusedTerminal() !== null,
			chat: !!el?.closest('.kg-chat, [data-chat-input]'),
			editor: !!el?.closest('.monaco-editor'),
			list: !!el?.closest('[role="tree"], [role="list"], [role="listbox"], [role="grid"]')
		});
		this.#remember();
		this.mode = 'help';
		this.content = null;
		this.help = helpText(
			context,
			(id, fallback) => {
				const cmd = commands.get(id);
				const key = cmd ? keyOf(cmd) : undefined;
				return key || fallback ? keyLabel((key ?? fallback)!) : '';
			},
			screenReaderMode()
		);
		this.open = true;
	}

	step(delta: 1 | -1) {
		if (this.content) this.content = { ...this.content, index: stepIndex(this.content, delta) };
	}

	close() {
		this.open = false;
		const back = this.#returnFocus;
		this.#returnFocus = null;
		if (back?.isConnected) queueMicrotask(() => back.focus());
	}
}

export const accessibleView = new AccessibleView();

export function installAccessibleViewCommands(): () => void {
	const category = 'Accessibility';
	const unregister = [
		commands.register({ id: 'editor.action.accessibleView', title: 'Open Accessible View', category, key: 'alt+f2', run: () => accessibleView.show() }),
		commands.register({ id: 'editor.action.accessibilityHelp', title: 'Open Accessibility Help', category, key: 'alt+f1', run: () => accessibleView.showHelp() }),
		commands.register({ id: 'editor.action.accessibleViewNext', title: 'Show Next in Accessible View', category, key: 'alt+]', when: () => accessibleView.open && !!accessibleView.content, run: () => accessibleView.step(1) }),
		commands.register({ id: 'editor.action.accessibleViewPrevious', title: 'Show Previous in Accessible View', category, key: 'alt+[', when: () => accessibleView.open && !!accessibleView.content, run: () => accessibleView.step(-1) })
	];
	return () => unregister.forEach((u) => u());
}
