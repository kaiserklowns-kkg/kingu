import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { hostErrorText, signInCard } from './agentSignIn.ts';
import { applyEvent, initialRun, type SignInEvent } from './events.ts';
import { installable, installFor, parseRoute, servedAgent, type ManagedStatus } from './managedCli.ts';

setLocale('en');

const URL = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F&response_type=code&state=s';
const browser = (o: Partial<SignInEvent>): SignInEvent => ({ kind: 'sign_in', state: 'required', via: 'browser', agent: 'Antigravity', ...o });

describe('the sign-in card', () => {
	test("Kingu's server: Sign in with Google, then the page the agent would open, then the check", () => {
		const required = signInCard(browser({}));
		expect(required.title).toBe('Sign in to Antigravity');
		expect(required.body).toContain('Kingu never sees');
		expect(required.actions).toEqual([{ kind: 'sign_in', label: 'Sign in with Google', primary: true }]);
		expect(signInCard(browser({ state: 'starting' }))).toMatchObject({ busy: true, actions: [] });
		const waiting = signInCard(browser({ state: 'waiting', url: URL }));
		expect(waiting.status).toContain('browser');
		expect(waiting.actions.map((a) => [a.kind, 'url' in a ? a.url : null])).toEqual([
			['open', URL],
			['copy', URL]
		]);
		expect(signInCard(browser({ state: 'verifying' }))).toMatchObject({ busy: true, actions: [] });
		const failed = signInCard(browser({ state: 'failed', error: 'Google sign-in was cancelled' }));
		expect(failed.error).toBe("Couldn't sign in: Google sign-in was cancelled");
		expect(failed.actions).toEqual([{ kind: 'sign_in', label: 'Try again', primary: true }]);
		expect(signInCard(browser({ error: 'Antigravity is still not signed in.' })).error).toBe('Antigravity is still not signed in.');
		// No subscription: said plainly (Orca's strip), the chooser then offers what else is here.
		expect(signInCard(browser({ state: 'failed', error: 'SUBSCRIPTION_REQUIRED' })).error).toBe('This Google account has no Antigravity subscription.');
	});

	test('a Gemini API key or Agent Platform account: Settings or gcloud, no Google page', () => {
		const key = signInCard(browser({ method: 'gemini-api-key' }));
		expect(key.body).toContain('Gemini API key');
		expect(key.actions).toEqual([
			{ kind: 'settings', label: 'Open Antigravity settings', primary: true },
			{ kind: 'sign_in', label: 'Try again', primary: false }
		]);
		const failed = signInCard(browser({ method: 'gemini-api-key', state: 'failed', error: 'GEMINI_API_KEY is not set' }));
		expect(failed.error).toBe("Couldn't sign in: GEMINI_API_KEY is not set");
		const adc = signInCard(browser({ method: 'agent-platform' }));
		expect(adc.body).toContain('gcloud');
		expect(adc.actions[0]).toEqual({ kind: 'terminal', label: 'Sign in with gcloud', primary: true, run: ['gcloud', 'auth', 'application-default', 'login'] });
		expect(adc.actions.map((a) => a.kind)).toEqual(['terminal', 'sign_in', 'settings']);
		expect(signInCard(browser({ method: 'agent-platform', state: 'verifying' }))).toMatchObject({ busy: true, actions: [] });
	});

	test("agy: its own login in a terminal, then I've signed in", () => {
		const card = signInCard({ kind: 'sign_in', state: 'required', via: 'terminal', agent: 'Antigravity', login: ['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy'] });
		expect(card.body).toContain('terminal');
		expect(card.actions).toEqual([
			{ kind: 'terminal', label: 'Sign in in a terminal', primary: true, run: ['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy'] },
			{ kind: 'sign_in', label: "I've signed in", primary: false }
		]);
		expect(signInCard({ kind: 'sign_in', state: 'verifying', via: 'terminal', agent: 'Antigravity' }).busy).toBe(true);
	});

	test('the run waits on the card, not in the timeline, until signed in or ended', () => {
		const s = initialRun();
		applyEvent(s, browser({}));
		expect([s.status, s.signIn?.state, s.items.length]).toEqual(['waiting', 'required', 0]);
		applyEvent(s, browser({ state: 'waiting', url: URL }));
		expect(s.signIn?.url).toBe(URL);
		applyEvent(s, browser({ state: 'signed_in' }));
		expect([s.status, s.signIn]).toEqual(['starting', null]);
		applyEvent(s, browser({}));
		applyEvent(s, { kind: 'exit', code: null, signal: null, stopped: true });
		expect([s.signIn, s.status]).toEqual([null, 'stopped']);
	});
});

describe("Antigravity's two installs", () => {
	const status = (agent: string, o: Partial<ManagedStatus> = {}): ManagedStatus => ({ agent, label: 'Antigravity', available: true, version: null, downloadBytes: null, downloadHost: null, installedVersion: null, installedCurrent: false, damaged: false, canRemove: false, source: null, operation: null, ...o });
	const list = [status('antigravity'), status('antigravity-server'), status('copilot', { label: 'GitHub Copilot' })];

	test('a chat installs what its route runs: agy, or Kingu’s server', () => {
		expect(installFor(list, 'antigravity', null)?.agent).toBe('antigravity');
		expect(installFor(list, 'antigravity', { route: 'agy', installs: 'antigravity' })?.agent).toBe('antigravity');
		expect(installFor(list, 'antigravity', { route: 'server', installs: 'antigravity-server' })?.agent).toBe('antigravity-server');
		expect(installFor(list, 'copilot', { route: 'server', installs: 'antigravity-server' })?.agent).toBe('copilot');
		expect([parseRoute({ route: 'server', installs: 'antigravity-server' }), parseRoute({ route: 'elsewhere', installs: 'x' }), parseRoute(null)]).toEqual([{ route: 'server', installs: 'antigravity-server' }, null, null]);
	});

	test('the server is never a picker row of its own and draws as Antigravity', () => {
		expect(installable(list, []).map((s) => s.agent)).toEqual(['antigravity', 'copilot']);
		expect([servedAgent('antigravity-server'), servedAgent('copilot')]).toEqual(['antigravity', 'copilot']);
	});
});

describe("the host's \"sign in in a terminal first\"", () => {
	const detail = 'Authentication required';
	test('reads in the UI language, the agent’s own words after it', () => {
		expect(hostErrorText(`Sign in to cursor-agent in a terminal first. ${detail}`)).toBe(`Sign in to cursor-agent in a terminal first, then start the chat again. ${detail}`);
		// An older chat's mixed Thai-and-English line reads in one language too.
		const old = `ต้องลงชื่อเข้าใช้ cursor-agent ก่อน: เปิดในเทอร์มินัลแล้วลงชื่อเข้าใช้ (Sign in to cursor-agent in a terminal first.) ${detail}`;
		expect(hostErrorText(old)).toBe(`Sign in to cursor-agent in a terminal first, then start the chat again. ${detail}`);
		setLocale('th');
		try {
			expect(hostErrorText(old)).toBe(`ลงชื่อเข้าใช้ cursor-agent ในเทอร์มินัลก่อน แล้วเริ่มแชตใหม่ ${detail}`);
		} finally {
			setLocale('en');
		}
		expect(hostErrorText('Sign in to gemini in a terminal first.')).toBe('Sign in to gemini in a terminal first, then start the chat again.');
		expect(hostErrorText('the agent exited')).toBe('the agent exited');
	});
});

describe('Cursor: `cursor-agent login` in a terminal, then I’ve signed in', () => {
	test('the card runs its login', () => {
		const card = signInCard({ kind: 'sign_in', state: 'required', via: 'terminal', agent: 'Cursor', login: ['cursor-agent', 'login'] });
		expect(card.title).toBe('Sign in to Cursor');
		expect(card.actions).toEqual([
			{ kind: 'terminal', label: 'Sign in in a terminal', primary: true, run: ['cursor-agent', 'login'] },
			{ kind: 'sign_in', label: "I've signed in", primary: false }
		]);
	});
});
