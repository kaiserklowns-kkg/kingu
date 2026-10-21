// What VS Code's chat.* settings decide in the Agent chat, apart from fonts (ade/chatLook.ts) and
// math (ChatMarkdown.svelte): notifications (chat.notifyWindowOn*), the rewind confirms
// (chat.editing.confirmEditRequest*), how thinking shows (chat.agent.thinkingStyle), a new chat's
// mode (chat.newSession.defaultMode) and long pastes (chat.pasteAsAttachmentThreshold). Pure, so
// `bun test` covers it; chatSettings.svelte.ts applies the ones that need the app.

import { t } from '#lib/i18n/index.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { isUntitled } from '#lib/workbench/untitled.ts';
import { isFileKey, type ContextText } from './chatPrompt.ts';
import { ASK_AGENT, type ModePick } from './customizations.ts';

type Get = (id: string) => unknown;

// ---- notifications -------------------------------------------------------------------------

export type NotifyWhen = 'off' | 'windowNotFocused' | 'always';
const NOTIFY_WHEN: readonly NotifyWhen[] = ['off', 'windowNotFocused', 'always'];

/** The setting that decides a chat event's notification: a confirmation or question, a response; null for other events. */
export function notifySettingFor(ev: { kind: string }): 'chat.notifyWindowOnConfirmation' | 'chat.notifyWindowOnResponseReceived' | null {
	if (ev.kind === 'permission_request') return 'chat.notifyWindowOnConfirmation';
	if (ev.kind === 'result') return 'chat.notifyWindowOnResponseReceived';
	return null;
}

/** Whether a chat event notifies (VS Code's chatWindowNotifier), given whether the window has focus. */
export function chatNotifies(ev: { kind: string }, get: Get, focused: boolean): boolean {
	const key = notifySettingFor(ev);
	if (!key) return false;
	const v = get(key);
	const when: NotifyWhen = NOTIFY_WHEN.includes(v as NotifyWhen) ? (v as NotifyWhen) : 'windowNotFocused';
	return when === 'always' || (when === 'windowNotFocused' && !focused);
}

// ---- rewind confirms -----------------------------------------------------------------------

/** The Kingu setting chat.editing.confirmEditRequestRemoval replaced; a `false` left in settings.json still counts. */
export const LEGACY_CONFIRM = 'kingu.chat.confirmRewind';
export const CONFIRM_REMOVAL = 'chat.editing.confirmEditRequestRemoval';
export const CONFIRM_RETRY = 'chat.editing.confirmEditRequestRetry';

/**
 * Whether a rewind asks first: Retry reads chat.editing.confirmEditRequestRetry, Restore
 * Checkpoint and Edit chat.editing.confirmEditRequestRemoval. Unset in the user's settings, an
 * old `kingu.chat.confirmRewind: false` turns both off. `user`: the raw user value of a key.
 */
export function confirmsRewind(kind: 'removal' | 'retry', get: Get, user: Get): boolean {
	const key = kind === 'retry' ? CONFIRM_RETRY : CONFIRM_REMOVAL;
	if (user(key) === undefined && user(LEGACY_CONFIRM) === false) return false;
	return get(key) !== false;
}

// ---- thinking ------------------------------------------------------------------------------

export type ThinkingStyle = 'collapsed' | 'collapsedPreview' | 'fixedScrolling';
const STYLES: readonly ThinkingStyle[] = ['collapsed', 'collapsedPreview', 'fixedScrolling'];
export const thinkingStyle = (v: unknown): ThinkingStyle => (STYLES.includes(v as ThinkingStyle) ? (v as ThinkingStyle) : 'fixedScrolling');

/** The fixed-height streaming panel's height (VS Code's THINKING_SCROLL_MAX_HEIGHT). */
export const THINKING_SCROLL_PX = 200;

/**
 * How a thinking part shows: `closed` (its header only), `open` (all of it) or `scroll` (the
 * fixed-height panel that follows the text). `live`: the agent is still on it (it streams, or it
 * is the turn's last part while the turn runs). `toggled`: the user's click, which wins.
 */
export function thinkingView(style: ThinkingStyle, live: boolean, toggled: boolean | undefined): 'closed' | 'open' | 'scroll' {
	if (toggled !== undefined) return toggled ? 'open' : 'closed';
	if (style === 'collapsedPreview') return live ? 'open' : 'closed';
	if (style === 'fixedScrolling') return live ? 'scroll' : 'closed';
	return 'closed';
}

// ---- a new chat's mode ---------------------------------------------------------------------

/**
 * chat.newSession.defaultMode as a mode pick: agent, ask or plan (any case), else a custom agent
 * by name; null when it is empty or names nothing Kingu has (then kingu.agent.permissionMode
 * decides). VS Code's `edit` mode has no Kingu counterpart and reads as Agent.
 */
export function defaultModePick(value: unknown, agents: readonly { name: string }[]): ModePick | null {
	const v = typeof value === 'string' ? value.trim() : '';
	if (!v) return null;
	const lower = v.toLowerCase();
	if (lower === 'agent' || lower === 'edit') return 'agent';
	if (lower === ASK_AGENT) return 'ask';
	if (lower === 'plan') return 'plan';
	const custom = agents.find((a) => a.name === v) ?? agents.find((a) => a.name.toLowerCase() === lower);
	return custom ? `custom:${custom.name}` : null;
}

// ---- saving before a send -------------------------------------------------------------------

/** The dirty editors chat.saveBeforeSend saves: files, not untitled editors, diffs or `scheme:` resources. */
export const savedBeforeSend = (dirty: readonly string[]) => dirty.filter((p) => isFileKey(p) && !isUntitled(p) && !isDiffKey(p));

// ---- pastes --------------------------------------------------------------------------------

/** chat.pasteAsAttachmentThreshold: a pasted text longer than it goes as attached context instead of into the input. */
export function pastedContext(text: string, threshold: unknown): ContextText | null {
	const limit = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 ? threshold : 10000;
	if (text.length <= limit) return null;
	const lines = text.split('\n').length;
	return { kind: 'paste', label: t('chatRender.pasted', { count: lines }), text };
}
