// The Send Later scheduler (VS Code 1.147's scheduled chat requests; sendLater.ts has the rules):
// the scheduled messages of every folder, kept in this machine's localStorage, and a timer that
// sends the due ones of the open folder into their chat (queued behind a running turn). A message
// whose folder is not open waits ("Waiting to send") until it is; one whose chat is gone is dropped.
// Each message is taken out of storage before it is sent, so two windows never send it twice.

import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { locale, t } from '#lib/i18n/index.ts';
import { chats, type OutgoingMessage } from './chats.svelte.ts';
import { absoluteLater, chatScheduled, dueMessages, parseScheduled, relativeLater, type ScheduledMessage } from './sendLater.ts';

const KEY = 'kingu.chat.scheduled';
const TICK_MS = 15_000;

function read(): ScheduledMessage[] {
	try {
		return parseScheduled(localStorage.getItem(KEY), Date.now());
	} catch {
		return [];
	}
}

function write(items: ScheduledMessage[]): boolean {
	try {
		localStorage.setItem(KEY, JSON.stringify(items));
		return true;
	} catch {
		return false;
	}
}

class SendLater {
	items = $state<ScheduledMessage[]>([]);
	#started = false;
	#sending = false;

	/** Loads the list and starts the timer (once; the chat panel calls it when it mounts). */
	start() {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;
		this.items = read();
		setInterval(() => void this.tick(), TICK_MS);
		// Another window scheduled, sent or cancelled one.
		window.addEventListener('storage', (e) => {
			if (e.key === KEY) this.items = read();
		});
		void this.tick();
	}

	forChat(root: string | null, chatId: string | null): ScheduledMessage[] {
		return chatScheduled(this.items, root, chatId);
	}

	/** Schedules `message` for chat `chatId` of `root`; false when it could not be kept. */
	add(root: string, chatId: string, label: string, message: OutgoingMessage, runAt: number): boolean {
		const now = Date.now();
		const item: ScheduledMessage = { id: `later-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, root, chatId, label, message, runAt, createdAt: now };
		const next = [...read(), item];
		if (!write(next)) {
			notifications.error(t('sendLater.saveFailed'));
			return false;
		}
		this.items = next;
		// "In less than a minute" is not a reason to wait for the next tick.
		if (runAt - now < TICK_MS) setTimeout(() => void this.tick(), Math.max(0, runAt - now) + 50);
		return true;
	}

	/** Takes `id` out of the list (Cancel Schedule, Edit, or before it is sent); undefined when another window already did. */
	take(id: string): ScheduledMessage | undefined {
		const all = read();
		const item = all.find((s) => s.id === id);
		if (item) write(all.filter((s) => s.id !== id));
		this.items = all.filter((s) => s.id !== id);
		return item;
	}

	reschedule(id: string, runAt: number) {
		const all = read();
		if (!all.some((s) => s.id === id)) return;
		const next = all.map((s) => (s.id === id ? { ...s, runAt, failed: false } : s));
		if (write(next)) this.items = next;
	}

	/** Send Now: into the chat at once (queued behind a running turn). */
	async sendNow(id: string) {
		const item = this.take(id);
		if (item) await this.#send(item);
	}

	/** Sends the open folder's due messages, oldest first. */
	async tick() {
		if (this.#sending || !chats.loaded || !chats.root) return;
		this.#sending = true;
		try {
			this.items = read();
			for (const due of dueMessages(this.items, chats.root, Date.now())) {
				const item = this.take(due.id);
				if (item) await this.#send(item);
			}
		} finally {
			this.#sending = false;
		}
	}

	async #send(item: ScheduledMessage) {
		if (!chats.get(item.chatId)) {
			// Its chat was deleted: nothing to send it to.
			notifications.info(t('sendLater.chatGone', { text: item.label.slice(0, 60) }));
			return;
		}
		const sent = await chats.submit(item.chatId, { ...item.message }, item.label, 'queue');
		if (sent === false) {
			// Not sent (chats.send said why): back in the list as "Not sent", for Send Now; the timer leaves it.
			const all = read();
			const back = { ...item, failed: true };
			if (write([...all, back])) this.items = [...all, back];
		}
	}
}

export const sendLater = new SendLater();

/** "Today at 3:40 PM", "Tomorrow at 9:00 AM", "Fri at …", "Dec 3 at …" (VS Code's getScheduledRequestAbsoluteTimeLabel). */
export function exactLabel(at: number, now = Date.now()): string {
	const a = absoluteLater(at, now, locale());
	if (a.kind === 'today') return t('sendLater.at.today', { clock: a.clock });
	if (a.kind === 'tomorrow') return t('sendLater.at.tomorrow', { clock: a.clock });
	return t('sendLater.at.day', { day: a.day, clock: a.clock });
}

/** "Sends in 10 minutes", "Waiting to send", "Not sent" (VS Code's getScheduledRequestTimeLabel). */
export function relativeLabel(s: Pick<ScheduledMessage, 'runAt' | 'failed'>, now = Date.now()): string {
	if (s.failed) return t('sendLater.notSent');
	const r = relativeLater(s.runAt, now);
	if (r.kind === 'due') return t('sendLater.due');
	if (r.kind === 'soon') return t('sendLater.soon');
	return t(r.kind === 'minutes' ? 'sendLater.in.minutes' : r.kind === 'hours' ? 'sendLater.in.hours' : 'sendLater.in.days', { count: r.n });
}
