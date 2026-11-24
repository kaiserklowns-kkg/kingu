// Passphrase / password prompts for Kingu's background ssh (Rust ssh_askpass.rs; Orca's
// `ssh:credential-request` → its passphrase dialog → `ssh:submitCredential`). One prompt at a time,
// in the main window, ssh's whole question shown above the input (sshCredential.ts): a secret is
// typed hidden, a host key question is Yes / No (No declines, like Cancel); Escape cancels,
// which declines the host until it is tested again (SSH Hosts › Test). The answer goes straight
// to ssh through a FIFO and is kept only in Kingu's memory.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from '#lib/i18n/index.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { windowLabel } from '#lib/workbench/windowEvents.ts';
import { hostKeyAnswer, isHostKeyQuestion, messageRuns } from './sshCredential';
import { sshHosts } from './sshHosts.svelte';

type Request = { id: string; target: string; prompt: string; echo: boolean };

const queue: Request[] = [];
const asked = new Set<string>();
let showing = false;

async function next() {
	if (showing) return;
	const r = queue.shift();
	if (!r) return;
	showing = true;
	try {
		const host = sshHosts.targets.find((x) => x.id === r.target)?.label ?? r.target;
		// ssh's whole question is shown wrapped above the input; the placeholder stays short.
		const message = messageRuns(r.prompt);
		let value: string | null | undefined;
		if (r.echo && isHostKeyQuestion(r.prompt)) {
			const choice = await quick.choose({
				title: t('sshRemote.hostKeyTitle', { host }),
				message,
				placeholder: t('sshRemote.hostKeyPlaceholder'),
				items: [
					{ id: 'yes', label: t('sshRemote.hostKeyYes'), description: t('sshRemote.hostKeyYesDetail') },
					{ id: 'no', label: t('sshRemote.hostKeyNo'), description: t('sshRemote.hostKeyNoDetail') }
				]
			});
			value = hostKeyAnswer(choice?.id);
		} else {
			value = await quick.input({
				title: t('sshRemote.credentialTitle', { host }),
				message,
				placeholder: t(r.echo ? 'sshRemote.credentialAnswerPlaceholder' : 'sshRemote.credentialSecretPlaceholder'),
				password: !r.echo,
				hint: () => t(r.echo ? 'sshRemote.credentialAnswer' : 'sshRemote.credentialHint', { host })
			});
		}
		await invoke('ssh_submit_credential', { id: r.id, value: value ?? null }).catch(() => {});
	} finally {
		showing = false;
		void next();
	}
}

function add(r: Request) {
	if (asked.has(r.id)) return;
	asked.add(r.id);
	queue.push(r);
	void next();
}

export function installSshCredentials(): () => void {
	if (windowLabel() !== 'main') return () => {};
	let off: (() => void) | undefined;
	let gone = false;
	void listen<Request>('ssh:credential-request', (e) => add(e.payload)).then((u) => (gone ? u() : (off = u)));
	void invoke<Request[]>('ssh_pending_credentials').then((list) => list.forEach(add)).catch(() => {});
	return () => {
		gone = true;
		off?.();
	};
}
