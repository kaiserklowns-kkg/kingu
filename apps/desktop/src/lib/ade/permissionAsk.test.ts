import { describe, expect, test } from 'bun:test';
import { approvalDetail, denyMessage, grantKey, MAX_DENY_MESSAGE, MAX_DETAIL, MAX_GRANT_VALUE, MAX_GRANTS, permissionAsk, scopedGrants, sessionGrants } from './permissionAsk';

describe('what a permission prompt asks', () => {
	test("Orca's summary: the command, path, URL or pattern, else the input as JSON", () => {
		expect(approvalDetail({ command: 'npm test', description: 'Run tests' })).toBe('npm test');
		expect(approvalDetail({ file_path: '/w/a.ts', content: 'x' })).toBe('/w/a.ts');
		expect(approvalDetail({ url: 'https://example.com' })).toBe('https://example.com');
		expect(approvalDetail({ query: 'x' })).toBe('{"query":"x"}');
		expect(approvalDetail({})).toBe('');
		expect(approvalDetail(undefined)).toBe('');
		expect(approvalDetail({ command: 'x'.repeat(MAX_DETAIL + 5) })).toHaveLength(MAX_DETAIL + 1);
	});

	test('the request carries the tool, the detail and the session grants', () => {
		const ask = permissionAsk('Bash', { command: 'npm test' }, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }]);
		expect(ask).toEqual({ tool: 'Bash', detail: 'npm test', grants: [{ kind: 'rule', value: 'Bash(npm test:*)' }] });
		expect(permissionAsk('Edit', { file_path: '/w/a.ts' })).toEqual({ tool: 'Edit', detail: '/w/a.ts', grants: [] });
		expect(permissionAsk(undefined, undefined)).toBeUndefined();
	});

	test('a command that leaves the sandbox is flagged and gets no session grant', () => {
		const ask = permissionAsk('Bash', { command: 'curl example.com', dangerouslyDisableSandbox: true }, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
		expect(ask).toEqual({ tool: 'Bash', detail: 'curl example.com', unsandboxed: true, grants: [] });
	});
});

describe('session grants (the same rules as hooks.rs session_grants)', () => {
	test('only allow rules, added folders and accept-edits are kept, in order', () => {
		const grants = sessionGrants([
			{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'WebFetch' }], behavior: 'allow', destination: 'localSettings' },
			{ type: 'addDirectories', directories: ['/w'], destination: 'userSettings' },
			{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
			{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
			{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
			{ type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
			{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 7 }], behavior: 'allow', destination: 'session' },
			{ type: 'addRules', rules: [], behavior: 'allow' },
			'nonsense'
		]);
		expect(grants.map(grantKey)).toEqual(['rule:Bash(npm test:*)', 'rule:WebFetch', 'dir:/w', 'mode:acceptEdits']);
	});

	test('past the limits nothing is offered', () => {
		expect(sessionGrants([{ type: 'addDirectories', directories: ['x'.repeat(MAX_GRANT_VALUE + 1)] }, { type: 'setMode', mode: 'acceptEdits' }])).toEqual([]);
		expect(sessionGrants([{ type: 'addDirectories', directories: Array.from({ length: MAX_GRANTS + 1 }, (_, i) => `/d${i}`) }])).toEqual([]);
		expect(sessionGrants(undefined)).toEqual([]);
		expect(sessionGrants({})).toEqual([]);
	});
});

test('a deny reason is one bounded line', () => {
	expect(denyMessage('  use\n pnpm  instead ')).toBe('use pnpm instead');
	expect(denyMessage(' \n ')).toBeUndefined();
	expect(denyMessage(undefined)).toBeUndefined();
	expect(denyMessage('x'.repeat(900))).toHaveLength(MAX_DENY_MESSAGE);
});

describe('settings-file scopes (permission_rules.rs scoped_grants)', () => {
	test('"Always allow" saves only the allow rules Claude suggested, never folders, modes or other kinds', () => {
		const grants = sessionGrants([
			{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
			{ type: 'addDirectories', directories: ['/w'], destination: 'localSettings' },
			{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
			{ type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' },
			{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' },
			{ type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'projectSettings' },
			{ type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' }
		]);
		expect(scopedGrants(grants, 'session').map(grantKey)).toEqual(['rule:Bash(npm test:*)', 'dir:/w', 'mode:acceptEdits']);
		for (const scope of ['project', 'user'] as const) expect(scopedGrants(grants, scope).map(grantKey)).toEqual(['rule:Bash(npm test:*)']);
		expect(scopedGrants(sessionGrants([{ type: 'setMode', mode: 'acceptEdits' }]), 'user')).toEqual([]);
	});
});
