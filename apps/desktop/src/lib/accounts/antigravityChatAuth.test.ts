import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import {
	alternativeHint,
	alternativeLabel,
	chatAuthAlternatives,
	chatAuthMenuItems,
	chatAuthValue,
	chipText,
	googleSignInFailureLead,
	otherLiveChats,
	parseDetection,
	projectLine,
	readChatAuth,
	switchedChatAuth,
	type AgyDetection
} from './antigravityChatAuth.ts';

setLocale('en');

describe("Antigravity's account type", () => {
	test('reads the setting as Orca does: unset or unknown is a Google account; a saved project stays with any method', () => {
		expect(readChatAuth(undefined)).toEqual({ method: 'oauth-personal' });
		expect(readChatAuth({ method: 'oauth-business', gcpProject: 'x' })).toEqual({ method: 'oauth-personal' });
		expect(readChatAuth({ method: 'gemini-api-key', gcpProject: 'kept' })).toEqual({ method: 'gemini-api-key', gcpProject: 'kept' });
		expect(readChatAuth({ method: 'agent-platform', gcpProject: ' p ', gcpLocation: '' })).toEqual({ method: 'agent-platform', gcpProject: 'p' });
	});

	test('writes no key for the default and no empty project fields', () => {
		expect(chatAuthValue({ method: 'oauth-personal' })).toBeUndefined();
		expect(chatAuthValue({ method: 'gemini-api-key' })).toEqual({ method: 'gemini-api-key' });
		expect(chatAuthValue({ method: 'agent-platform', gcpProject: ' ', gcpLocation: 'us-central1' })).toEqual({ method: 'agent-platform', gcpLocation: 'us-central1' });
		expect(chatAuthValue({ method: 'oauth-personal', gcpProject: 'p' })).toEqual({ method: 'oauth-personal', gcpProject: 'p' });
	});

	test("says which project Agent Platform would use and where it came from", () => {
		const base = { location: 'global', credentialsFile: '/h/.config/gcloud/application_default_credentials.json', credentialsFound: true };
		expect(projectLine({ ...base, project: 'acme-dev', projectSource: 'gcloud' })).toBe('Uses project acme-dev (from gcloud config) in global.');
		expect(projectLine({ ...base, project: null, projectSource: null })).toContain('No Google Cloud project');
	});
});

const found = (o: Partial<AgyDetection> = {}): AgyDetection => ({
	method: 'oauth-personal',
	googleSignIn: false,
	apiKey: { available: false, source: null },
	adc: { available: false, project: null },
	liveChats: 0,
	...o
});

describe("Chat's chip and chooser (Orca 04c88e0df)", () => {
	test("reads Rust's detection, which never carries a key", () => {
		expect(parseDetection(null)).toBeNull();
		expect(parseDetection({ method: 'gemini-api-key', googleSignIn: true, apiKey: { available: true, source: 'environment' }, adc: { available: true, project: 'acme' }, liveChats: 2 })).toEqual(
			found({ method: 'gemini-api-key', googleSignIn: true, apiKey: { available: true, source: 'environment' }, adc: { available: true, project: 'acme' }, liveChats: 2 })
		);
		expect(parseDetection({ method: 'oauth-business', apiKey: { source: 'elsewhere' } })).toEqual(found({ method: null }));
	});

	test('offers what is here besides the method in use: a key, then gcloud with its project, then a saved Google sign-in', () => {
		expect(chatAuthAlternatives(null)).toEqual([]);
		const all = found({ googleSignIn: true, apiKey: { available: true, source: 'environment' }, adc: { available: true, project: 'acme-dev' } });
		expect(chatAuthAlternatives(all)).toEqual([{ method: 'gemini-api-key', source: 'environment' }, { method: 'agent-platform', project: 'acme-dev' }]);
		expect(chatAuthAlternatives({ ...all, method: 'gemini-api-key' })).toEqual([{ method: 'agent-platform', project: 'acme-dev' }, { method: 'oauth-personal' }]);
		// gcloud without a project it can name isn't one click.
		expect(chatAuthAlternatives(found({ method: 'gemini-api-key', adc: { available: true, project: null } }))).toEqual([]);
	});

	test("says them in Orca's words, Kingu for Orca", () => {
		expect(alternativeLabel({ method: 'agent-platform', project: 'acme-dev' })).toBe('Use gcloud (acme-dev)');
		expect(alternativeLabel({ method: 'gemini-api-key', source: 'saved' })).toBe('Use your Gemini API key');
		expect(alternativeHint({ method: 'gemini-api-key', source: 'environment' })).toBe('Found GEMINI_API_KEY in your environment');
		expect(alternativeHint({ method: 'gemini-api-key', source: 'saved' })).toBe('Saved in Kingu');
		expect(alternativeHint({ method: 'agent-platform', project: 'p' })).toBe('Found your gcloud login (Application Default Credentials)');
		expect(alternativeLabel({ method: 'oauth-personal' })).toBe('Use your Google sign-in');
	});

	test("the chip's menu: every method in a fixed order, Detected marks, Settings for what needs input", () => {
		const items = chatAuthMenuItems(found({ apiKey: { available: true, source: 'saved' }, adc: { available: true, project: null } }));
		expect(items).toEqual([
			{ method: 'oauth-personal', active: true, detected: false, opensSettings: false },
			{ method: 'gemini-api-key', active: false, detected: true, opensSettings: false },
			{ method: 'agent-platform', active: false, detected: false, opensSettings: true }
		]);
		expect(chipText(found({ method: 'agent-platform', adc: { available: true, project: 'acme-dev' } }), false)).toBe('Google Agent Platform · acme-dev');
		expect(chipText(found({ method: null }), false)).toBeNull();
		expect(chipText(null, true)).toBe('agy sign-in');
	});

	test('a switch keeps the saved project and location; the asking chat is not counted', () => {
		expect(switchedChatAuth({ method: 'agent-platform', gcpProject: 'p', gcpLocation: 'eu' }, 'gemini-api-key')).toEqual({ method: 'gemini-api-key', gcpProject: 'p', gcpLocation: 'eu' });
		expect(switchedChatAuth({ method: 'gemini-api-key' }, 'oauth-personal')).toBeUndefined();
		expect(otherLiveChats(found({ liveChats: 1 }), true)).toBe(0);
		expect(otherLiveChats(found({ liveChats: 1 }), false)).toBe(1);
	});

	test('a Google sign-in refused for want of a subscription is said plainly', () => {
		expect(googleSignInFailureLead('SUBSCRIPTION_REQUIRED: …')).toBe('This Google account has no Antigravity subscription.');
		expect(googleSignInFailureLead('Your account is ineligible')).toBe("This Google account can't use Antigravity.");
		expect(googleSignInFailureLead('cancelled')).toBeNull();
	});
});
