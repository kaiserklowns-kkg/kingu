import { describe, expect, test } from 'bun:test';
import { cloneUrlError, defaultParents, progressLabel, projectNameError, repoNameFromUrl } from './repoDialog.ts';

describe('clone dialog', () => {
	test('accepts https, ssh and scp-like URLs only', () => {
		for (const ok of ['https://github.com/acme/app.git', 'ssh://git@github.com/acme/app', 'git@github.com:acme/app.git', ' https://gitlab.com/g/s/app ']) expect(cloneUrlError(ok)).toBeNull();
		for (const bad of ['', 'file:///tmp/r', '/tmp/r', 'http://github.com/a/b', 'git://x/y', 'ext::sh -c x', '-u https://x', 'https://github.com/a/b#main', 'https://-o/x', 'https://github.com', '../r'])
			expect(cloneUrlError(bad)).not.toBeNull();
	});
	test('folder name from the URL', () => {
		expect(repoNameFromUrl('https://github.com/acme/app.git')).toBe('app');
		expect(repoNameFromUrl('git@github.com:acme/my-lib')).toBe('my-lib');
		expect(repoNameFromUrl('https://h/x/tool/')).toBe('tool');
		expect(repoNameFromUrl('https://h/..')).toBe('');
	});
	test('project names and defaults', () => {
		expect(projectNameError('demo')).toBeNull();
		for (const bad of ['', ' ', 'a/b', '..', '.', '-x']) expect(projectNameError(bad)).not.toBeNull();
		expect(defaultParents('/Users/me/')).toEqual({ clone: '/Users/me/kingu', project: '/Users/me/kingu/projects' });
		expect(progressLabel({ phase: 'Receiving objects', percent: 42 })).toBe('Receiving objects 42%');
		expect(progressLabel(null)).toBe('กำลังเริ่ม clone…');
	});
});
