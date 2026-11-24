// The chat's sign-in card (Orca `NativeChatAntigravityAuth`, `AntigravityChatSignInAction`): what
// it says for the agent's `sign_in` event (agent-host acpSignIn.ts). Kingu never handles the
// credential: Sign in asks the agent to run Google's sign-in itself, or opens the agent's own
// login in a terminal. Antigravity's server on a Gemini API key or Google Agent Platform (`method`)
// has no Google page: the card points at the key in Settings, or at gcloud's own login. Pure, so
// `bun test` covers it.

import { t } from '#lib/i18n/index.ts';
import type { SignInEvent } from './events.ts';
import { googleSignInFailureLead } from '#lib/accounts/antigravityChatAuth.ts';

export type SignInAction =
	/** `agent_sign_in`: the agent starts its Google sign-in, or (terminal) is asked again. */
	| { kind: 'sign_in'; label: string; primary: boolean }
	/** Runs the agent's login in a Kingu terminal. */
	| { kind: 'terminal'; label: string; primary: boolean; run: string[] }
	/** Opens or copies the link the agent would open. */
	| { kind: 'open' | 'copy'; label: string; primary: boolean; url: string }
	/** Opens Settings › Accounts › Antigravity (the Gemini API key, Agent Platform's project). */
	| { kind: 'settings'; label: string; primary: boolean };

/** gcloud's own sign-in for Application Default Credentials (Orca's Agent Platform hint). */
export const GCLOUD_ADC_LOGIN = ['gcloud', 'auth', 'application-default', 'login'];

export type SignInCard = {
	title: string;
	body: string | null;
	/** A step in progress (polite live region). */
	status: string | null;
	error: string | null;
	busy: boolean;
	actions: SignInAction[];
};

export function signInCard(ev: SignInEvent): SignInCard {
	const agent = ev.agent;
	const title = t('managedCli.signIn.title', { agent });
	const card = (o: Partial<SignInCard>): SignInCard => ({ title, body: null, status: null, error: null, busy: false, actions: [], ...o });
	const signIn = (label: string, primary = true): SignInAction => ({ kind: 'sign_in', label, primary });
	if (ev.via === 'terminal') {
		const login = ev.login?.length ? ev.login : null;
		if (ev.state === 'verifying' || ev.state === 'starting') return card({ status: t('managedCli.signIn.verifying'), busy: true });
		return card({
			body: t('managedCli.signIn.terminalBody', { agent }),
			error: ev.error ?? null,
			actions: [...(login ? [{ kind: 'terminal', label: t('managedCli.signIn.terminalButton'), primary: true, run: login } as const] : []), signIn(t('managedCli.signIn.continue'), !login)]
		});
	}
	if (ev.method === 'gemini-api-key' || ev.method === 'agent-platform') {
		if (ev.state === 'starting' || ev.state === 'verifying' || ev.state === 'signed_in') return card({ status: t('managedCli.signIn.verifying'), busy: true });
		const key = ev.method === 'gemini-api-key';
		const settings: SignInAction = { kind: 'settings', label: t('agentAccounts.signIn.settings'), primary: key };
		return card({
			body: t(key ? 'agentAccounts.signIn.keyBody' : 'agentAccounts.signIn.adcBody', { agent }),
			error: ev.state === 'failed' ? t('managedCli.signIn.failed', { error: ev.error ?? '?' }) : (ev.error ?? null),
			actions: key
				? [settings, signIn(t('agentAccounts.signIn.check'), false)]
				: [{ kind: 'terminal', label: t('agentAccounts.signIn.gcloud'), primary: true, run: GCLOUD_ADC_LOGIN }, signIn(t('agentAccounts.signIn.check'), false), settings]
		});
	}
	switch (ev.state) {
		case 'starting':
			return card({ status: t('managedCli.signIn.starting'), busy: true });
		case 'waiting':
			return ev.url
				? card({ status: t('managedCli.signIn.waiting'), busy: true, actions: [{ kind: 'open', label: t('managedCli.signIn.open'), primary: true, url: ev.url }, { kind: 'copy', label: t('managedCli.signIn.copy'), primary: false, url: ev.url }] })
				: card({ status: t('managedCli.signIn.starting'), busy: true });
		case 'verifying':
		case 'signed_in':
			return card({ status: t('managedCli.signIn.verifying'), busy: true });
		case 'failed':
			// No subscription, or an account Antigravity refuses: said plainly, as Orca's strip does.
			return card({ body: t('managedCli.signIn.browserBody', { agent }), error: googleSignInFailureLead(ev.error) ?? t('managedCli.signIn.failed', { error: ev.error ?? '?' }), actions: [signIn(t('managedCli.signIn.retry'))] });
		default:
			return card({ body: t('managedCli.signIn.browserBody', { agent }), error: ev.error ?? null, actions: [signIn(t('managedCli.signIn.button'))] });
	}
}

// The agent host's "not signed in" for an agent the chat cannot sign in itself (agent-host acp.ts
// `signInMessage`): English, then the agent's own words. Older chats kept the Thai-and-English
// form, `ต้องลงชื่อเข้าใช้ X ก่อน: … (Sign in to X in a terminal first.) <agent's words>`.
const SIGN_IN_FIRST = /^(?:ต้องลงชื่อเข้าใช้ \S+ ก่อน: [^(]*\()?Sign in to (\S+) in a terminal first\.\)?(?:\s+([\s\S]*))?$/u;

/** A run's error in the UI's language when the agent host sent a sentence the chat knows; else as sent. */
export function hostErrorText(message: string): string {
	const m = SIGN_IN_FIRST.exec(message.trim());
	if (!m) return message;
	const lead = t('managedCli.signIn.firstInTerminal', { agent: m[1]! });
	const detail = m[2]?.trim();
	return detail ? `${lead} ${detail}` : lead;
}
