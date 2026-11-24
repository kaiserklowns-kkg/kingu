import { expect, test } from 'bun:test';
import { TRIPLES, plan } from './build-ptyd-host';

const mac = { platform: 'darwin', hostTriple: 'aarch64-apple-darwin', installed: [...TRIPLES], zigbuild: true };

test('a mac with zig builds every host platform', () => {
	expect(TRIPLES.map((t) => plan(t, mac))).toEqual([
		{ cmd: ['cargo', 'zigbuild', '--release', '--locked', '-p', 'kingu-ptyd', '--target', 'x86_64-unknown-linux-musl'] },
		{ cmd: ['cargo', 'zigbuild', '--release', '--locked', '-p', 'kingu-ptyd', '--target', 'aarch64-unknown-linux-musl'] },
		{ cmd: ['cargo', 'build', '--release', '--locked', '-p', 'kingu-ptyd', '--target', 'aarch64-apple-darwin'] },
		{ cmd: ['cargo', 'build', '--release', '--locked', '-p', 'kingu-ptyd', '--target', 'x86_64-apple-darwin'] }
	]);
});

test('what cannot be built is skipped with its reason, never faked', () => {
	expect(plan('aarch64-unknown-linux-musl', { ...mac, installed: ['aarch64-apple-darwin'] })).toEqual({ skip: 'the Rust target is not installed (rustup target add aarch64-unknown-linux-musl)' });
	expect('skip' in plan('x86_64-unknown-linux-musl', { ...mac, zigbuild: false })).toBe(true);
	const linux = { platform: 'linux', hostTriple: 'x86_64-unknown-linux-musl', installed: [...TRIPLES], zigbuild: false };
	expect(plan('x86_64-unknown-linux-musl', linux)).toEqual({ cmd: ['cargo', 'build', '--release', '--locked', '-p', 'kingu-ptyd', '--target', 'x86_64-unknown-linux-musl'] });
	expect(plan('aarch64-apple-darwin', linux)).toEqual({ skip: 'macOS binaries need a macOS build machine' });
});
