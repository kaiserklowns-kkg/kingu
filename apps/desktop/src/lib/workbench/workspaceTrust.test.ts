import { describe, expect, test } from 'bun:test';
import { addTrusted, parentOf, removeTrusted, resolveTrust, shouldPrompt, showBanner, trustedBy, trustSettings, untrustedFilesAction, within, type TrustInput } from './workspaceTrust.ts';

const on = { enabled: true, emptyWindow: true };
const input = (o: Partial<TrustInput>): TrustInput => ({ settings: on, folders: [], workspaceFile: null, trusted: [], ...o });

describe('workspace trust', () => {
	test('a trusted folder trusts its subfolders, by whole path segments', () => {
		expect(within('/a/b/c', '/a/b')).toBe(true);
		expect(within('/a/b', '/a/b/')).toBe(true);
		expect(within('/a/bc', '/a/b')).toBe(false);
		expect(within('/a', '/a/b')).toBe(false);
		expect(within('/anything', '/')).toBe(true);
		expect(within('/a', '')).toBe(false);
		expect(trustedBy('/r/TrustedRepos/kingu/src', ['/r/TrustedRepos', '/r/TrustedRepos/kingu'])).toBe('/r/TrustedRepos/kingu');
		expect(trustedBy('/r/ForEvaluation/x', ['/r/TrustedRepos'])).toBeNull();
	});

	test('a folder under a trusted parent is trusted by inheritance', () => {
		const s = resolveTrust(input({ folders: ['/r/TrustedRepos/kingu'], trusted: ['/r/TrustedRepos'] }));
		expect(s).toEqual({ trusted: true, disabled: false, empty: false, inherited: { '/r/TrustedRepos/kingu': '/r/TrustedRepos' }, untrusted: [] });
		// Trusted itself: nothing inherited (the editor offers Don't Trust).
		expect(resolveTrust(input({ folders: ['/w/app'], trusted: ['/w/app/'] })).inherited).toEqual({});
		expect(resolveTrust(input({ folders: ['/w/app'], trusted: ['/w/other'] }))).toMatchObject({ trusted: false, untrusted: ['/w/app'] });
	});

	test('multi-root: every folder and the saved workspace file must be trusted', () => {
		const folders = ['/repos/a', '/repos/b'];
		expect(resolveTrust(input({ folders, trusted: ['/repos'] })).trusted).toBe(true);
		expect(resolveTrust(input({ folders: [...folders, '/tmp/c'], trusted: ['/repos'] }))).toMatchObject({ trusted: false, untrusted: ['/tmp/c'] });
		expect(resolveTrust(input({ folders, workspaceFile: '/w/x.code-workspace', trusted: ['/repos'] }))).toMatchObject({ trusted: false, untrusted: ['/w/x.code-workspace'] });
		expect(resolveTrust(input({ folders, workspaceFile: '/w/x.code-workspace', trusted: ['/repos', '/w'] })).trusted).toBe(true);
	});

	test('empty windows follow emptyWindow unless picked for the session; trust off trusts all', () => {
		expect(resolveTrust(input({})).trusted).toBe(true);
		expect(resolveTrust(input({ settings: { enabled: true, emptyWindow: false } })).trusted).toBe(false);
		expect(resolveTrust(input({ emptyOverride: false })).trusted).toBe(false);
		expect(resolveTrust(input({ settings: { enabled: true, emptyWindow: false }, emptyOverride: true })).trusted).toBe(true);
		expect(resolveTrust(input({ settings: { enabled: false, emptyWindow: true }, folders: ['/x'] }))).toMatchObject({ trusted: true, disabled: true });
	});

	test('edits the trusted list', () => {
		expect(addTrusted(['/a'], ['/a/', '/b/', 'relative', '/b'])).toEqual(['/a', '/b']);
		expect(removeTrusted(['/a', '/b/', '/c'], ['/b', '/c/'])).toEqual(['/a']);
		expect(parentOf('/r/TrustedRepos/kingu/')).toBe('/r/TrustedRepos');
		expect(parentOf('/top')).toBe('/');
		expect(parentOf('/')).toBe('/');
	});

	test('startup prompt and banner follow their settings', () => {
		const untrusted = resolveTrust(input({ folders: ['/x'] }));
		const trusted = resolveTrust(input({ folders: ['/x'], trusted: ['/x'] }));
		const empty = resolveTrust(input({ settings: { enabled: true, emptyWindow: false } }));
		expect(shouldPrompt({ enabled: true, startupPrompt: 'never' }, untrusted, false)).toBe(false);
		expect(shouldPrompt({ enabled: true, startupPrompt: 'once' }, untrusted, false)).toBe(true);
		expect(shouldPrompt({ enabled: true, startupPrompt: 'once' }, untrusted, true)).toBe(false);
		expect(shouldPrompt({ enabled: true, startupPrompt: 'always' }, untrusted, true)).toBe(true);
		expect(shouldPrompt({ enabled: true, startupPrompt: 'always' }, trusted, false)).toBe(false);
		// No prompt for an empty window (nothing to trust).
		expect(shouldPrompt({ enabled: true, startupPrompt: 'always' }, empty, false)).toBe(false);
		expect(showBanner({ banner: 'untilDismissed' }, untrusted, false)).toBe(true);
		expect(showBanner({ banner: 'untilDismissed' }, untrusted, true)).toBe(false);
		expect(showBanner({ banner: 'always' }, untrusted, true)).toBe(true);
		expect(showBanner({ banner: 'never' }, untrusted, false)).toBe(false);
		expect(showBanner({ banner: 'always' }, trusted, false)).toBe(false);
	});

	test('untrusted files in a trusted window', () => {
		const s = { enabled: true, untrustedFiles: 'prompt' as const };
		const trusted = resolveTrust(input({ folders: ['/w'], trusted: ['/w'] }));
		expect(untrustedFilesAction(s, trusted, ['/w/a.ts'], ['/w'], false)).toBe('open');
		expect(untrustedFilesAction(s, trusted, ['/w/a.ts', '/tmp/x.ts'], ['/w'], false)).toBe('prompt');
		expect(untrustedFilesAction(s, trusted, ['/tmp/x.ts'], ['/w'], true)).toBe('open');
		expect(untrustedFilesAction({ ...s, untrustedFiles: 'newWindow' }, trusted, ['/tmp/x.ts'], ['/w'], false)).toBe('newWindow');
		expect(untrustedFilesAction({ ...s, untrustedFiles: 'open' }, trusted, ['/tmp/x.ts'], ['/w'], false)).toBe('open');
		// A Restricted Mode window takes anything (it is restricted already).
		expect(untrustedFilesAction(s, resolveTrust(input({ folders: ['/w'] })), ['/tmp/x.ts'], [], false)).toBe('open');
		// An empty window trusted by emptyWindow asks too.
		expect(untrustedFilesAction(s, resolveTrust(input({})), ['/tmp/x.ts'], [], false)).toBe('prompt');
	});

	test('reads the settings with VS Code defaults', () => {
		expect(trustSettings(() => undefined)).toEqual({ enabled: true, startupPrompt: 'never', banner: 'untilDismissed', untrustedFiles: 'prompt', emptyWindow: true });
		const values: Record<string, unknown> = { 'security.workspace.trust.startupPrompt': 'once', 'security.workspace.trust.banner': 'bogus', 'security.workspace.trust.enabled': 'no' };
		expect(trustSettings((id) => values[id])).toMatchObject({ startupPrompt: 'once', banner: 'untilDismissed', enabled: true });
	});
});
