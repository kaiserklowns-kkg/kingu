import { describe, expect, test } from 'bun:test';
import { freePortCommand, quickFixes } from './quickFixes.ts';

describe('terminal quick fixes', () => {
	test('a port in use: free it and run again', () => {
		const node = "Error: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle";
		expect(quickFixes('npm run dev', node, 1)).toEqual([{ kind: 'run', command: `${freePortCommand('3000')} && npm run dev`, label: { key: 'freePort', params: { port: '3000' } } }]);
		const python = 'OSError: [Errno 48] Address already in use: port 8000';
		expect(quickFixes('python -m http.server 8000', python, 1)[0]).toMatchObject({ label: { params: { port: '8000' } } });
		const vite = 'Error: Port 5173 is already in use';
		expect(quickFixes('vite --strictPort', vite, 1)[0]).toMatchObject({ label: { params: { port: '5173' } } });
		// A command that succeeded needs no fix.
		expect(quickFixes('npm run dev', node, 0)).toEqual([]);
		expect(freePortCommand('3000')).toBe('kill $(lsof -t -i tcp:3000)');
	});

	test('git push without an upstream', () => {
		const out = 'fatal: The current branch feat/x has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin feat/x\n';
		expect(quickFixes('git push', out, 128)).toEqual([{ kind: 'run', command: 'git push --set-upstream origin feat/x', label: { key: 'setUpstream', params: { remote: 'origin', branch: 'feat/x' } } }]);
		// A branch name git printed is never run when it is not a plain word.
		expect(quickFixes('git push', out.replace(/feat\/x/g, 'x;rm -rf ~'), 128)).toEqual([]);
	});

	test('a mistyped git subcommand', () => {
		const one = "git: 'stauts' is not a git command. See 'git --help'.\n\nThe most similar command is\n\tstatus\n";
		expect(quickFixes('git stauts -s', one, 1).map((f) => f.kind === 'run' && f.command)).toEqual(['git status -s']);
		const many = "git: 'psh' is not a git command. See 'git --help'.\n\nThe most similar commands are\n\tpush\n\tpull\n";
		expect(quickFixes('git psh', many, 1).map((f) => f.kind === 'run' && f.command)).toEqual(['git push', 'git pull']);
	});

	test('a pull request link from git push', () => {
		const out = "remote: \nremote: Create a pull request for 'feat' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/feat\nremote: \n";
		expect(quickFixes('git push -u origin feat', out, 0)).toEqual([{ kind: 'open', url: 'https://github.com/o/r/pull/new/feat', label: { key: 'openPr', params: { url: 'https://github.com/o/r/pull/new/feat' } } }]);
	});

	test('nothing for ordinary output', () => {
		expect(quickFixes('ls', 'a\nb\n', 0)).toEqual([]);
		expect(quickFixes('cat nope', 'cat: nope: No such file or directory', 1)).toEqual([]);
	});
});
