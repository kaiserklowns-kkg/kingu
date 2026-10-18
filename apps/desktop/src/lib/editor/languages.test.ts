import { describe, expect, test } from 'bun:test';
import { languageFor, languageName, languageNames, lspLanguageId, registerMonacoLanguages } from './languages.ts';

describe('language association (VS Code languagesAssociations)', () => {
	test('extensions from VS Code built-in extensions', () => {
		const cases: [string, string][] = [
			['src/App.tsx', 'typescriptreact'],
			['src/App.jsx', 'javascriptreact'],
			['a.ts', 'typescript'],
			['a.mts', 'typescript'],
			['a.cjs', 'javascript'],
			['run.sh', 'shell'],
			['x.bash', 'shell'],
			['.zshrc', 'shell'],
			['main.c', 'c'],
			['a.h', 'cpp'],
			['a.cc', 'cpp'],
			['kernel.cu', 'cpp'],
			['Main.java', 'java'],
			['schema.sql', 'sql'],
			['a.rb', 'ruby'],
			['index.php', 'php'],
			['a.cs', 'csharp'],
			['a.swift', 'swift'],
			['a.m', 'objective-c'],
			['a.ps1', 'powershell'],
			['a.xml', 'xml'],
			['icon.svg', 'xml'],
			['a.xsl', 'xml'],
			['a.mk', 'makefile'],
			['fix.patch', 'diff'],
			['a.ini', 'ini'],
			['.editorconfig', 'properties'],
			['.gitignore', 'ignore'],
			['.env', 'dotenv'],
			['README.md', 'markdown'],
			['a.yaml', 'yaml'],
			['a.lua', 'lua'],
			['a.r', 'r'],
			['a.pug', 'pug'],
			['a.coffee', 'coffee'],
			['a.bat', 'bat'],
			['a.dockerfile', 'dockerfile'],
			['notes.txt', 'plaintext']
		];
		for (const [path, id] of cases) expect([path, languageFor(path)]).toEqual([path, id]);
	});

	test('file names and file name patterns win over extensions', () => {
		expect(languageFor('Dockerfile')).toBe('dockerfile');
		expect(languageFor('build/Dockerfile.prod')).toBe('dockerfile');
		expect(languageFor('Makefile')).toBe('makefile');
		expect(languageFor('GNUmakefile')).toBe('makefile');
		expect(languageFor('PKGBUILD')).toBe('shell');
		expect(languageFor('Gemfile')).toBe('ruby');
		expect(languageFor('.env.local')).toBe('dotenv');
		expect(languageFor('compose.yaml')).toBe('yaml');
		expect(languageFor('Cargo.lock')).toBe('toml');
		// Case-insensitive like VS Code.
		expect(languageFor('makefile')).toBe('makefile');
		expect(languageFor('A.TSX')).toBe('typescriptreact');
		// Longest extension wins: `.d.ts` is still TypeScript, `.js.map` is JSON.
		expect(languageFor('lib.d.ts')).toBe('typescript');
		expect(languageFor('app.js.map')).toBe('json');
		expect(languageFor('tsconfig.json')).toBe('json');
	});

	test('first line (shebangs, xml) only when the path says nothing', () => {
		expect(languageFor('bin/deploy', { firstLine: '#!/usr/bin/env bash' })).toBe('shell');
		expect(languageFor('bin/tool', { firstLine: '#!/usr/bin/env python3' })).toBe('python');
		expect(languageFor('bin/serve', { firstLine: '#!/usr/bin/env node' })).toBe('javascript');
		expect(languageFor('bin/x', { firstLine: '#!/usr/bin/env bun' })).toBe('typescript');
		expect(languageFor('data', { firstLine: '﻿<?xml version="1.0"?>' })).toBe('xml');
		expect(languageFor('notes', { firstLine: 'hello' })).toBe('plaintext');
		// The extension wins over the shebang.
		expect(languageFor('a.py', { firstLine: '#!/bin/sh' })).toBe('python');
	});

	test('files.associations: highest priority, longest pattern, unknown ids ignored', () => {
		const associations = { '*.tmpl': 'html', 'config/*.conf': 'ini', '*.ts': 'javascript', '*.weird': 'no-such-language' };
		const known = (id: string) => id !== 'no-such-language';
		expect(languageFor('views/a.tmpl', { associations, known })).toBe('html');
		expect(languageFor('config/app.conf', { associations, known })).toBe('ini');
		expect(languageFor('other/app.conf', { associations, known })).toBe('properties');
		expect(languageFor('a.ts', { associations, known })).toBe('javascript');
		expect(languageFor('x.weird', { associations, known })).toBe('plaintext');
		// A more specific (longer) user pattern wins.
		expect(languageFor('a.test.ts', { associations: { '*.ts': 'javascript', '*.test.ts': 'typescriptreact' } })).toBe('typescriptreact');
		// An exact file name pattern.
		expect(languageFor('Jenkinsfile', { associations: { Jenkinsfile: 'shell' } })).toBe('shell');
	});

	test("Monaco's own languages fill in below VS Code's", () => {
		registerMonacoLanguages([
			{ id: 'kotlin', aliases: ['Kotlin'], extensions: ['.kt', '.kts'] },
			// Monaco registers .tsx for typescript; VS Code's typescriptreact must keep it.
			{ id: 'typescript', aliases: ['TypeScript'], extensions: ['.ts', '.tsx'] },
			{ id: 'graphql', aliases: ['GraphQL'], extensions: ['.graphql', '.gql'] }
		]);
		expect(languageFor('a.kt')).toBe('kotlin');
		expect(languageFor('q.gql')).toBe('graphql');
		expect(languageFor('App.tsx')).toBe('typescriptreact');
		expect(languageName('kotlin')).toBe('Kotlin');
	});

	test('names and LSP ids follow VS Code', () => {
		expect(languageName('shell')).toBe('Shell Script');
		expect(languageName('typescriptreact')).toBe('TypeScript JSX');
		expect(languageName('plaintext')).toBe('Plain Text');
		expect(languageNames(['typescript', 'jsx-tags', 'c', 'c']).map((l) => l.id)).toEqual(['c', 'typescript']);
		expect(lspLanguageId('shell', 'a.sh')).toBe('shellscript');
		expect(lspLanguageId('json', 'tsconfig.json')).toBe('jsonc');
		expect(lspLanguageId('javascriptreact', 'a.jsx')).toBe('javascriptreact');
	});
});
