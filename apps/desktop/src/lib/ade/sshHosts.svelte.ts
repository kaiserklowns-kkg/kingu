// SSH Hosts (Orca's Settings › SSH and its plain-SSH terminals): saved remote machines, imported
// from ~/.ssh/config or typed in, a connection test, a terminal on the machine and port forwards.
// Rust ssh_hosts.rs runs the system ssh, so keys, agent, ProxyJump and known hosts work as usual.
import { invoke } from '@tauri-apps/api/core';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeLayout } from './adeLayout.svelte';
import { parseDestination, parseForward, type SshTarget } from './sshHosts';
import { sshProjects } from './sshProjects.svelte';
import { installSshCredentials } from './sshCredentials.svelte';

export type TestResult = { success: boolean; error: string | null; millis: number };
export type Forward = { id: string; target_id: string; local_port: number; remote_host: string; remote_port: number; label: string | null; running: boolean };
type ConfigHost = { alias: string; hostname: string; port: number; username: string; already_added: boolean };
type ConfigListing = { hosts: ConfigHost[]; total_host_count: number; new_host_count: number; match_count: number; has_more: boolean };

export type RemoteDir = { path: string; entries: string[]; truncated: boolean };
export type SavedForward = { target_id: string; local_port: number; remote_host: string; remote_port: number; label: string | null };
/** What a host row shows below itself: its files or its listening ports. */
export type HostPanel = { kind: 'files'; dir: RemoteDir | null; loading: boolean; error: string | null } | { kind: 'ports'; ports: number[] | null; loading: boolean; error: string | null };

class SshHosts {
	open = $state(false);
	targets = $state<SshTarget[]>([]);
	forwards = $state<Forward[]>([]);
	unrestored = $state<SavedForward[]>([]);
	tests = $state<Record<string, TestResult | 'testing'>>({});
	panels = $state<Record<string, HostPanel>>({});

	async show() {
		this.open = true;
		await this.refresh();
	}

	async refresh() {
		this.targets = (await invoke<SshTarget[]>('ssh_targets_list').catch(() => [])) ?? [];
		this.forwards = (await invoke<Forward[]>('ssh_forwards_list').catch(() => [])) ?? [];
		this.unrestored = (await invoke<SavedForward[]>('ssh_unrestored_forwards').catch(() => [])) ?? [];
	}

	/** Files on the host (Orca's ssh:browseDir): `path` empty → the login folder. */
	async browse(id: string, path = '') {
		const prev = this.panels[id];
		this.panels[id] = { kind: 'files', dir: prev?.kind === 'files' ? prev.dir : null, loading: true, error: null };
		try {
			const dir = await invoke<RemoteDir>('ssh_browse_dir', { id, path });
			this.panels[id] = { kind: 'files', dir, loading: false, error: null };
		} catch (e) {
			this.panels[id] = { kind: 'files', dir: prev?.kind === 'files' ? prev.dir : null, loading: false, error: String(e) };
		}
	}

	/** Ports listening on the host, each one click from a forward (Orca's detected ports). */
	async ports(id: string) {
		this.panels[id] = { kind: 'ports', ports: null, loading: true, error: null };
		try {
			this.panels[id] = { kind: 'ports', ports: await invoke<number[]>('ssh_detected_ports', { id }), loading: false, error: null };
		} catch (e) {
			this.panels[id] = { kind: 'ports', ports: null, loading: false, error: String(e) };
		}
	}

	closePanel(id: string) {
		delete this.panels[id];
	}

	/** Forwards remote `port` to the same local port (or the next free one Kingu doesn't use). */
	async forwardPort(t: SshTarget, port: number) {
		const taken = new Set(this.forwards.filter((f) => f.running).map((f) => f.local_port));
		let local = port;
		while (taken.has(local) && local < 65535) local++;
		try {
			await invoke('ssh_forward_add', { targetId: t.id, localPort: local, remoteHost: 'localhost', remotePort: port, label: null });
			status.flash(`Forwarding localhost:${local} → ${t.label}:${port}`, 5000);
		} catch (e) {
			notifications.error(String(e));
		}
		await this.refresh();
	}

	async restore(s: SavedForward) {
		try {
			await invoke('ssh_forward_add', { targetId: s.target_id, localPort: s.local_port, remoteHost: s.remote_host, remotePort: s.remote_port, label: s.label });
		} catch (e) {
			notifications.error(String(e));
		}
		await this.refresh();
	}

	async forget(s: SavedForward) {
		await invoke('ssh_forget_forward', { targetId: s.target_id, localPort: s.local_port }).catch((e) => notifications.error(String(e)));
		await this.refresh();
	}

	/** A terminal on the host, inside `path`. */
	async terminalIn(t: SshTarget, path: string) {
		if (!workspace.root) return void status.flash('Open a folder first: the SSH terminal opens as a tab of the Agents view', 5000);
		const argv = await invoke<string[]>('ssh_terminal_command_in', { id: t.id, path }).catch((e) => (notifications.error(String(e)), null));
		if (!argv) return;
		if (!appMode.isAgents) appMode.setMode('agents');
		adeLayout.newTerminal(adeLayout.key, { title: `ssh ${t.label}:${path.split('/').filter(Boolean).pop() ?? '/'}`, run: argv });
		this.open = false;
	}

	/** Import from SSH Config…: pick one of the config's hosts that isn't saved yet. */
	async importFromConfig() {
		const listing = await invoke<ConfigListing>('ssh_config_hosts', { query: '' }).catch((e) => (notifications.error(String(e)), null));
		if (!listing) return;
		const fresh = listing.hosts.filter((h) => !h.already_added);
		if (!fresh.length) return void status.flash(listing.total_host_count ? 'Every host in ~/.ssh/config is already added' : 'No hosts found in ~/.ssh/config', 5000);
		const pick = await quick.choose({
			placeholder: `Add a host from ~/.ssh/config (${fresh.length} new)`,
			items: fresh.map((h) => ({ id: h.alias, label: h.alias, description: `${h.username ? `${h.username}@` : ''}${h.hostname}${h.port !== 22 ? `:${h.port}` : ''}` }))
		});
		if (!pick) return;
		try {
			await invoke('ssh_import_config', { aliases: [pick.id] });
			await this.refresh();
		} catch (e) {
			notifications.error(String(e));
		}
	}

	/** Add Host…: `user@host:port`. */
	async add() {
		const text = await quick.input({ placeholder: 'user@host:port', hint: (v) => (parseDestination(v) ? `Add ${v.trim()}` : 'Type a host, e.g. deploy@10.0.0.5:2222') });
		const d = text ? parseDestination(text) : null;
		if (!d) return;
		try {
			await invoke('ssh_target_add', { target: { id: '', label: '', config_host: null, host: d.host, port: d.port, username: d.username, identity_file: null, jump_host: null, proxy_command: null } });
			await this.refresh();
		} catch (e) {
			notifications.error(String(e));
		}
	}

	async remove(id: string) {
		await invoke('ssh_target_remove', { id }).catch((e) => notifications.error(String(e)));
		await this.refresh();
	}

	async test(id: string) {
		this.tests[id] = 'testing';
		this.tests[id] = await invoke<TestResult>('ssh_test_connection', { id }).catch((e) => ({ success: false, error: String(e), millis: 0 }));
	}

	/** A terminal tab running ssh to the host (Orca's plain SSH terminal). */
	async terminal(t: SshTarget) {
		if (!workspace.root) return void status.flash('Open a folder first: the SSH terminal opens as a tab of the Agents view', 5000);
		const argv = await invoke<string[]>('ssh_terminal_command', { id: t.id }).catch((e) => (notifications.error(String(e)), null));
		if (!argv) return;
		if (!appMode.isAgents) appMode.setMode('agents');
		adeLayout.newTerminal(adeLayout.key, { title: `ssh ${t.label}`, run: argv });
		this.open = false;
	}

	/** Forward Port…: `3000` or `3000:localhost:5173` (local:remote host:remote port). */
	async forward(t: SshTarget) {
		const text = await quick.input({ placeholder: 'local port, or local:remote-host:remote-port', hint: (v) => (parseForward(v) ? `Forward ${v.trim()} through ${t.label}` : 'e.g. 3000, or 8080:localhost:80') });
		const f = text ? parseForward(text) : null;
		if (!f) return;
		try {
			await invoke('ssh_forward_add', { targetId: t.id, localPort: f.local, remoteHost: f.host, remotePort: f.remote, label: null });
			status.flash(`Forwarding localhost:${f.local} → ${t.label} ${f.host}:${f.remote}`, 5000);
		} catch (e) {
			notifications.error(String(e));
		}
		await this.refresh();
	}

	async stopForward(id: string) {
		await invoke('ssh_forward_remove', { id }).catch((e) => notifications.error(String(e)));
		await this.refresh();
	}
}

export const sshHosts = new SshHosts();

export function installSshCommands(): () => void {
	const off = [
		commands.register({ id: 'kingu.ssh.hosts', title: 'SSH: Hosts…', category: 'Agents', run: () => void sshHosts.show() }),
		commands.register({ id: 'kingu.ssh.import', title: 'SSH: Import Host from SSH Config…', category: 'Agents', run: () => void sshHosts.importFromConfig().then(() => sshHosts.show()) }),
		commands.register({ id: 'kingu.ssh.add', title: 'SSH: Add Host…', category: 'Agents', run: () => void sshHosts.add().then(() => sshHosts.show()) }),
		sshProjects.install(),
		installSshCredentials()
	];
	return () => off.forEach((u) => u());
}
