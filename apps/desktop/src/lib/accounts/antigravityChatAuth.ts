// `kingu.agent.antigravityChatAuth` (Orca `AntigravityChatAuthConfig`) as Settings shows and
// writes it, and the status Rust reports (agent/antigravity_auth.rs). Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';
import type { PlainKey } from '#lib/settings/orcaPane.ts';

export type AgyMethod = 'oauth-personal' | 'gemini-api-key' | 'agent-platform';
export type AgyChatAuth = { method: AgyMethod; gcpProject?: string; gcpLocation?: string };

export type AgentPlatformStatus = {
	project: string | null;
	projectSource: 'saved' | 'environment' | 'adc' | 'cloudsdkEnvironment' | 'gcloud' | null;
	location: string;
	credentialsFile: string;
	credentialsFound: boolean;
};

export type AgyAuthStatus = {
	method: AgyMethod | null;
	error: string | null;
	apiKeySaved: boolean;
	apiKeyInEnvironment: boolean;
	agentPlatform: AgentPlatformStatus;
	getKeyUrl: string;
};

/** Orca's order: Google first, then the key, then Agent Platform. */
export const AGY_METHODS: readonly { id: AgyMethod; label: PlainKey; hint: PlainKey }[] = [
	{ id: 'oauth-personal', label: 'agentAccounts.agy.personal', hint: 'agentAccounts.agy.personalHint' },
	{ id: 'gemini-api-key', label: 'agentAccounts.agy.key', hint: 'agentAccounts.agy.keyHint' },
	{ id: 'agent-platform', label: 'agentAccounts.agy.adc', hint: 'agentAccounts.agy.adcHint' }
];

const METHOD_IDS = new Set<string>(AGY_METHODS.map((m) => m.id));

/** The setting as Settings shows it: unset or unreadable is a Google account. A saved project and
 *  location are kept whatever the method, so switching away and back keeps them (Orca). */
export function readChatAuth(value: unknown): AgyChatAuth {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { method: 'oauth-personal' };
	const v = value as Record<string, unknown>;
	const known = typeof v.method === 'string' && METHOD_IDS.has(v.method);
	if (!known) return { method: 'oauth-personal' };
	const text = (k: string) => (typeof v[k] === 'string' && (v[k] as string).trim() ? (v[k] as string).trim() : undefined);
	const project = text('gcpProject');
	const location = text('gcpLocation');
	return { method: v.method as AgyMethod, ...(project ? { gcpProject: project } : {}), ...(location ? { gcpLocation: location } : {}) };
}

/** What Settings writes: a Google account with nothing else is the default (no key); empty project fields are left out. */
export function chatAuthValue(a: AgyChatAuth): AgyChatAuth | undefined {
	const project = a.gcpProject?.trim();
	const location = a.gcpLocation?.trim();
	if (a.method === 'oauth-personal' && !project && !location) return undefined;
	return { method: a.method, ...(project ? { gcpProject: project } : {}), ...(location ? { gcpLocation: location } : {}) };
}

/** Which project Agent Platform would use (Orca `04c88e0df` names it too) and where it came from (Kingu-only). */
export function projectLine(p: AgentPlatformStatus): string {
	if (!p.project) return t('agentAccounts.agy.noProject');
	const source = p.projectSource ? t(`agentAccounts.agy.source.${p.projectSource}` as const) : '?';
	return t('agentAccounts.agy.resolved', { project: p.project, source, location: p.location });
}

// ---- Chat's chip and chooser (Orca `04c88e0df`: antigravity-chat-auth-choices.ts, antigravity-auth-words.ts) ----

/** What Rust found here (`antigravity_chat_auth_detect`): whether a credential exists and where, never the credential. */
export type AgyDetection = {
	/** The saved account type; null while the setting can't be read. */
	method: AgyMethod | null;
	/** Kingu's server holds a Google sign-in from before. */
	googleSignIn: boolean;
	apiKey: { available: boolean; source: 'saved' | 'environment' | null };
	adc: { available: boolean; project: string | null };
	/** Antigravity chats running now; a switch stops them. */
	liveChats: number;
};

const isMethod = (v: unknown): v is AgyMethod => typeof v === 'string' && METHOD_IDS.has(v);

/** Rust's answer, or null when it isn't one. */
export function parseDetection(v: unknown): AgyDetection | null {
	if (!v || typeof v !== 'object') return null;
	const o = v as Record<string, unknown>;
	const key = (o.apiKey ?? {}) as Record<string, unknown>;
	const adc = (o.adc ?? {}) as Record<string, unknown>;
	return {
		method: isMethod(o.method) ? o.method : null,
		googleSignIn: o.googleSignIn === true,
		apiKey: { available: key.available === true, source: key.source === 'saved' || key.source === 'environment' ? key.source : null },
		adc: { available: adc.available === true, project: typeof adc.project === 'string' && adc.project ? adc.project : null },
		liveChats: typeof o.liveChats === 'number' && o.liveChats > 0 ? Math.floor(o.liveChats) : 0
	};
}

/** A method this computer already has credentials for, applied in one click. */
export type AgyAlternative = { method: 'gemini-api-key'; source: 'saved' | 'environment' } | { method: 'agent-platform'; project: string } | { method: 'oauth-personal' };

/** Detected methods other than the one in use, best first (Orca `antigravityChatAuthAlternatives`):
 *  a key needs no Google Cloud project, gcloud needs one it can name, and a saved Google sign-in
 *  comes last because it is what failed most often (no subscription). */
export function chatAuthAlternatives(d: AgyDetection | null): AgyAlternative[] {
	if (!d) return [];
	const out: AgyAlternative[] = [];
	if (d.method !== 'gemini-api-key' && d.apiKey.available && d.apiKey.source) out.push({ method: 'gemini-api-key', source: d.apiKey.source });
	if (d.method !== 'agent-platform' && d.adc.available && d.adc.project) out.push({ method: 'agent-platform', project: d.adc.project });
	if (d.method !== 'oauth-personal' && d.googleSignIn) out.push({ method: 'oauth-personal' });
	return out;
}

export type AgyMenuItem = {
	method: AgyMethod;
	active: boolean;
	/** This computer has credentials the method would use. */
	detected: boolean;
	/** Needs what only Settings collects: a key to paste, or a project. */
	opensSettings: boolean;
};

/** Every method in a fixed order, so the chip's menu doesn't reshuffle as detections arrive (Orca `antigravityChatAuthMenuItems`). */
export function chatAuthMenuItems(d: AgyDetection | null): AgyMenuItem[] {
	const current = d?.method ?? null;
	const adcReady = Boolean(d?.adc.available && d.adc.project);
	const detected: Record<AgyMethod, boolean> = { 'oauth-personal': Boolean(d?.googleSignIn), 'gemini-api-key': Boolean(d?.apiKey.available), 'agent-platform': adcReady };
	return AGY_METHODS.map(({ id }) => ({
		method: id,
		active: id === current,
		detected: detected[id],
		opensSettings: id !== current && ((id === 'gemini-api-key' && !detected[id]) || (id === 'agent-platform' && !adcReady))
	}));
}

/** The setting after a one-click switch: a saved project and location stay (Orca's apply). */
export function switchedChatAuth(current: AgyChatAuth, method: AgyMethod): AgyChatAuth | undefined {
	return chatAuthValue({ ...current, method });
}

export const methodLabel = (m: AgyMethod): string => t(AGY_METHODS.find((x) => x.id === m)!.label);

/** The chooser's button (Orca `antigravityAlternativeLabel`). */
export function alternativeLabel(o: AgyAlternative): string {
	if (o.method === 'gemini-api-key') return t('agentAccounts.chat.useApiKey');
	if (o.method === 'agent-platform') return t('agentAccounts.chat.useGcloud', { project: o.project });
	return t('agentAccounts.chat.useGoogle');
}

/** Where Kingu found the credential (Orca `antigravityAlternativeHint`). */
export function alternativeHint(o: AgyAlternative): string {
	if (o.method === 'gemini-api-key') return o.source === 'environment' ? t('agentAccounts.chat.apiKeyFromEnvironment') : t('agentAccounts.chat.apiKeySaved');
	if (o.method === 'agent-platform') return t('agentAccounts.chat.gcloudFound');
	return t('agentAccounts.chat.googleFound');
}

/** The chip's text: the method in use (with gcloud's project), or agy's own login for a chat on agy. */
export function chipText(d: AgyDetection | null, onAgy: boolean): string | null {
	if (onAgy) return t('agentAccounts.chat.agy');
	if (!d?.method) return null;
	const label = methodLabel(d.method);
	return d.method === 'agent-platform' && d.adc.project ? `${label} · ${d.adc.project}` : label;
}

const SUBSCRIPTION = /SUBSCRIPTION_REQUIRED|eligible Antigravity subscription/i;
const INELIGIBLE = /ineligible|can't use Antigravity|can’t use Antigravity/i;

/** A failed Google sign-in another method gets around, said plainly (Orca's strip `failedLine`); null otherwise. */
export function googleSignInFailureLead(error: string | null | undefined): string | null {
	if (!error) return null;
	if (SUBSCRIPTION.test(error)) return t('agentAccounts.chat.noSubscription');
	if (INELIGIBLE.test(error)) return t('agentAccounts.chat.ineligible');
	return null;
}

/** Chats a switch would stop, besides the one asking (it waits on its sign-in, nothing in progress). */
export const otherLiveChats = (d: AgyDetection, asking: boolean): number => Math.max(0, d.liveChats - (asking ? 1 : 0));
