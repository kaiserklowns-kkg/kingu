import { describe, expect, test } from 'bun:test';
import { hostKeyAnswer, isHostKeyQuestion, messageRuns } from './sshCredential';

const FIRST_CONTACT = [
	"The authenticity of host '[127.0.0.1]:22223 ([127.0.0.1]:22223)' can't be established.",
	'ED25519 key fingerprint is SHA256:Xq3b1nE+o/9fZk2Lr0pV7yJ8wH4cT6uA5sD1gK0mN2Q.',
	'This key is not known by any other names.',
	'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
].join('\n');

describe('ssh askpass questions', () => {
	test('a host key question is told from a secret prompt', () => {
		expect(isHostKeyQuestion(FIRST_CONTACT)).toBe(true);
		expect(isHostKeyQuestion('Are you sure you want to continue connecting (yes/no)? ')).toBe(true);
		expect(isHostKeyQuestion("Enter passphrase for key '/Users/a/.ssh/id_ed25519': ")).toBe(false);
		expect(isHostKeyQuestion("bright@box's password: ")).toBe(false);
	});

	test('the whole question is kept, the fingerprint in monospace', () => {
		const runs = messageRuns(FIRST_CONTACT);
		expect(runs.map((r) => r.text).join('')).toBe(FIRST_CONTACT.trim());
		expect(runs.filter((r) => r.mono).map((r) => r.text)).toEqual(['SHA256:Xq3b1nE+o/9fZk2Lr0pV7yJ8wH4cT6uA5sD1gK0mN2Q']);
		expect(messageRuns('RSA key fingerprint is MD5:0a:1b:2c.').filter((r) => r.mono)[0]?.text).toBe('MD5:0a:1b:2c');
		expect(messageRuns('Enter passphrase: ')).toEqual([{ text: 'Enter passphrase:' }]);
	});

	test('Yes answers yes; No and Escape decline', () => {
		expect(hostKeyAnswer('yes')).toBe('yes');
		expect(hostKeyAnswer('no')).toBeNull();
		expect(hostKeyAnswer(undefined)).toBeNull();
	});
});
