// How an ssh askpass question (Rust ssh_askpass.rs) is shown. Pure.
//
// ssh's question can be several lines long: a first contact asks "The authenticity of host '…'
// can't be established. ED25519 key fingerprint is SHA256:…. Are you sure you want to continue
// connecting (yes/no/[fingerprint])?". It is shown whole, wrapped above the input (the fingerprint
// in monospace, since it is what the user checks); the input's placeholder stays short.
//
// Orca connects with its own ssh library and never shows this question: an unknown host is
// trusted on first contact and remembered (`accept-and-remember`, src/main/ssh/host-keys/
// ssh-host-key-decision.ts), unless StrictHostKeyChecking says otherwise. Kingu runs the system ssh,
// whose own question is kept (the user's known_hosts and ssh_config decide), and offered as
// Yes / No choices.

export type MessageRun = { text: string; mono?: boolean };

/** ssh's yes/no question about an unknown (or changed) host key. */
export function isHostKeyQuestion(prompt: string): boolean {
	return /\(yes\/no(\/\[fingerprint\])?\)\?\s*$/i.test(prompt.trim());
}

/** The prompt as text runs: key fingerprints (`SHA256:…`, `MD5:aa:bb:…`) are monospace; line
 * breaks are kept. */
export function messageRuns(prompt: string): MessageRun[] {
	const text = prompt.trim();
	const runs: MessageRun[] = [];
	const re = /(SHA256:[A-Za-z0-9+/=]+|MD5(?::[0-9a-f]{2})+)/g;
	let at = 0;
	for (const m of text.matchAll(re)) {
		const i = m.index ?? 0;
		if (i > at) runs.push({ text: text.slice(at, i) });
		runs.push({ text: m[0], mono: true });
		at = i + m[0].length;
	}
	if (at < text.length) runs.push({ text: text.slice(at) });
	return runs;
}

/** The answer ssh gets for a host key choice: `yes`, or none (No declines, like Cancel). */
export function hostKeyAnswer(choice: string | undefined): string | null {
	return choice === 'yes' ? 'yes' : null;
}
