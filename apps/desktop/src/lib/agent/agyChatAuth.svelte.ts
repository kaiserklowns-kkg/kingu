// How Antigravity chats sign in, from the chat (Orca `04c88e0df` native-chat-antigravity-auth.tsx):
// what this computer already has (Rust `antigravity_chat_auth_detect`: a Gemini API key saved in
// Kingu or in GEMINI_API_KEY, a gcloud ADC login and its project, a Google sign-in Kingu's server
// saved) and the one-click switch the chip and the sign-in card's chooser make. The webview learns
// only that a key exists and where; a switch to a key in the environment saves the account type,
// never the key (the server reads GEMINI_API_KEY at launch, as Orca's does).

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status as statusBar } from '#lib/workbench/status.svelte.ts';
import { methodLabel, otherLiveChats, parseDetection, readChatAuth, switchedChatAuth, type AgyDetection, type AgyMethod } from '#lib/accounts/antigravityChatAuth.ts';
import { chats } from './chats.svelte.ts';
import { managedCli } from './managedCli.svelte.ts';

export const AGY_CHAT_AUTH_SETTING = 'kingu.agent.antigravityChatAuth';

class AgyChatAuth {
	/** The last answer; kept when a re-read fails. */
	detection = $state<AgyDetection | null>(null);
	/** The method being applied; every switch control waits while one is. */
	switching = $state<AgyMethod | null>(null);
	#reading: Promise<boolean> | null = null;

	/** Reads again; false when Rust didn't answer. */
	refresh(): Promise<boolean> {
		return (this.#reading ??= invoke('antigravity_chat_auth_detect')
			.then((v) => {
				const d = parseDetection(v);
				if (d) this.detection = d;
				return d !== null;
			})
			.catch(() => false)
			.finally(() => (this.#reading = null)));
	}

	/** Settings › Accounts, scrolled to Antigravity (a key to paste, a project to enter). */
	openSettings() {
		systemSettings.showAccounts();
		setTimeout(() => document.getElementById('accounts-antigravity')?.scrollIntoView({ block: 'start' }), 50);
	}

	/**
	 * Saves `method` as the account type and restarts running Antigravity chats, which hold the old
	 * sign-in. Re-reads first: a chat may have started since. Asks before stopping chats, or when the
	 * re-read failed and can't rule them out. `chatId`: the chat whose sign-in card asked; it isn't
	 * counted (it waits on its sign-in) and its request is sent again with the new sign-in.
	 */
	async switchTo(method: AgyMethod, chatId?: string): Promise<void> {
		if (this.switching) return;
		const answered = await this.refresh();
		const current = answered ? this.detection : null;
		if (!chatId && current?.method === method) return;
		if (!current || otherLiveChats(current, chatId !== undefined) > 0) {
			const label = methodLabel(method);
			const ok = await ask(t('agentAccounts.chat.confirmBody'), { title: t('agentAccounts.chat.confirmTitle', { method: label }), kind: 'warning', okLabel: t('agentAccounts.chat.confirm') });
			if (!ok) return;
		}
		this.switching = method;
		try {
			await settings.set(AGY_CHAT_AUTH_SETTING, switchedChatAuth(readChatAuth(settings.get(AGY_CHAT_AUTH_SETTING)), method), 'user');
			// The asking chat's request, kept before its run ends (a stopped run may show only the saved transcript).
			const again = chatId ? chats.lastSent(chatId) : undefined;
			if (chatId) await chats.stopAndWait(chatId);
			await invoke('antigravity_chat_stop_live');
			// A key or gcloud runs on Kingu's server; a Google sign-in may go back to agy.
			void managedCli.refreshRoute();
			statusBar.flash(t('agentAccounts.chat.switched', { method: methodLabel(method) }), 4000);
			if (chatId) await (again ? chats.send(chatId, again) : chats.retry(chatId));
		} catch (e) {
			notifications.error(e instanceof Error && e.message ? e.message : typeof e === 'string' && e ? e : t('agentAccounts.chat.switchFailed'));
		} finally {
			this.switching = null;
			void this.refresh();
		}
	}
}

export const agyChatAuth = new AgyChatAuth();
