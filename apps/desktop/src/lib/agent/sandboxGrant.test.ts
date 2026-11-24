import { describe, expect, test } from 'bun:test';
import { DOMAINS_SETTING, grantedValue, grantSetting, PATHS_SETTING, withDomainGrant, withPathGrant } from './sandboxGrant';
import type { SandboxGrant } from './events';

const path = (over: Partial<Extract<SandboxGrant, { kind: 'path' }>> = {}): Extract<SandboxGrant, { kind: 'path' }> => ({
	kind: 'path',
	path: '/Users/me/out',
	access: 'readWrite',
	denied_path: '/Users/me/out/a.txt',
	persisted_path: '~/out',
	removed_readonly_paths: [],
	blocked: [],
	...over
});

describe('Allow for This User: the settings edit', () => {
	test('a path joins its list as written (~/…); other entries and lists stay', () => {
		expect(grantSetting(path())).toBe(PATHS_SETTING);
		expect(withPathGrant(undefined, path())).toEqual({ readwritePaths: ['~/out'] });
		expect(withPathGrant({ readwritePaths: ['~/a'], deniedPaths: ['~/.ssh'] }, path())).toEqual({ readwritePaths: ['~/a', '~/out'], deniedPaths: ['~/.ssh'] });
		expect(withPathGrant({ readonlyPaths: ['~/x'] }, path({ access: 'read', persisted_path: '~/notes' }))).toEqual({ readonlyPaths: ['~/x', '~/notes'] });
		// Again: no duplicate.
		expect(withPathGrant({ readwritePaths: ['~/out'] }, path())).toEqual({ readwritePaths: ['~/out'] });
	});

	test('an upgrade from read-only drops the read-only entry it replaces', () => {
		expect(withPathGrant({ readonlyPaths: ['docs', 'spec'], readwritePaths: [] }, path({ persisted_path: 'docs', removed_readonly_paths: ['docs'] }))).toEqual({ readonlyPaths: ['spec'], readwritePaths: ['docs'] });
	});

	test('domains join chat.agent.sandbox.network.allowedDomains', () => {
		const g: SandboxGrant = { kind: 'domain', domains: ['registry.npmjs.org', 'github.com'], blocked: [] };
		expect(grantSetting(g)).toBe(DOMAINS_SETTING);
		expect(withDomainGrant(['github.com'], g)).toEqual(['github.com', 'registry.npmjs.org']);
		expect(grantedValue(null, g)).toEqual(['registry.npmjs.org', 'github.com']);
	});
});
