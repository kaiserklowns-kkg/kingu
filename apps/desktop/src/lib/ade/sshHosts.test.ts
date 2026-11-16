import { describe, expect, test } from 'bun:test';
import { parseDestination, parseForward } from './sshHosts';

describe('parseDestination', () => {
	test('reads user, host and port', () => {
		expect(parseDestination('deploy@10.0.0.5:2222')).toEqual({ username: 'deploy', host: '10.0.0.5', port: 2222 });
		expect(parseDestination(' box.lan ')).toEqual({ username: '', host: 'box.lan', port: 22 });
		expect(parseDestination('me@[::1]:2200')).toEqual({ username: 'me', host: '::1', port: 2200 });
	});
	test('refuses what ssh would take as an option or a bad port', () => {
		expect(parseDestination('-oProxyCommand=x')).toBeNull();
		expect(parseDestination('a b')).toBeNull();
		expect(parseDestination('host:70000')).toBeNull();
		expect(parseDestination('@host')).toBeNull();
	});
});

describe('parseForward', () => {
	test('one, two or three parts', () => {
		expect(parseForward('3000')).toEqual({ local: 3000, host: 'localhost', remote: 3000 });
		expect(parseForward('8080:80')).toEqual({ local: 8080, host: 'localhost', remote: 80 });
		expect(parseForward('5432:db.internal:5432')).toEqual({ local: 5432, host: 'db.internal', remote: 5432 });
	});
	test('bad input', () => {
		expect(parseForward('')).toBeNull();
		expect(parseForward('0')).toBeNull();
		expect(parseForward('1:-x:2')).toBeNull();
	});
});
