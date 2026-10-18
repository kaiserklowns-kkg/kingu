// Status bar resources (Orca's footer): keep-awake, the Resource Manager (memory, CPU, processes,
// terminals) and listening ports, polled from Rust while the window is visible.
import { invoke } from '@tauri-apps/api/core';
import { status } from './status.svelte';
import { pushSample, type KeepAwakeMode } from './system';

export type PtyInfo = { id: string; pid: number | null; cwd: string };
export type ProcessRow = { pid: number; ppid: number; rss_bytes: number; cpu: number; name: string; stoppable?: boolean };
type Stats = {
	memory_bytes: number | null;
	cpu_percent: number | null;
	terminals: PtyInfo[];
	processes: ProcessRow[];
	keep_awake: boolean | null;
};
export type Port = { port: number; address: string; pid: number; name: string; ours: boolean };

const POLL_MS = 5000;
const PORTS_POLL_MS = 15000;

class SystemStats {
	stats = $state<Stats | null>(null);
	/** Recent memory readings for the Resource Manager's sparkline. */
	samples = $state<number[]>([]);
	ports = $state<Port[] | null>(null);
	portsError = $state('');
	scanning = $state(false);
	#timer: ReturnType<typeof setInterval> | undefined;
	#portsTimer: ReturnType<typeof setInterval> | undefined;

	async refresh() {
		if (typeof document !== 'undefined' && document.hidden) return;
		try {
			const s = await invoke<Stats>('system_stats');
			this.stats = s;
			if (s.memory_bytes !== null) this.samples = pushSample(this.samples, s.memory_bytes);
		} catch {
			// Not running under Tauri (or an older backend): the items stay hidden.
		}
	}

	async refreshPorts() {
		if (typeof document !== 'undefined' && document.hidden) return;
		this.scanning = true;
		try {
			this.ports = await invoke<Port[]>('system_ports');
			this.portsError = '';
		} catch (e) {
			this.portsError = String(e);
		} finally {
			this.scanning = false;
		}
	}

	start() {
		if (this.#timer) return;
		void this.refresh();
		void this.refreshPorts();
		this.#timer = setInterval(() => void this.refresh(), POLL_MS);
		this.#portsTimer = setInterval(() => void this.refreshPorts(), PORTS_POLL_MS);
	}

	/** Applies a keep-awake mode: `on` always, `auto` while `working`, `off` never. */
	async applyKeepAwake(mode: KeepAwakeMode, working: boolean) {
		const want = mode === 'on' || (mode === 'auto' && working);
		if (!this.stats || this.stats.keep_awake === null || this.stats.keep_awake === want) return;
		try {
			await invoke('keep_awake_set', { on: want });
		} catch (e) {
			status.flash(String(e), 5000);
		}
		await this.refresh();
	}

	/** SIGTERM to a process Kingu started (Rust refuses anything else). */
	async kill(pid: number, label: string) {
		try {
			await invoke('system_kill', { pid });
			status.flash(`หยุด ${label} แล้ว`, 3000);
		} catch (e) {
			status.flash(String(e), 5000);
		}
		await Promise.all([this.refresh(), this.refreshPorts()]);
	}

	async openPort(port: number) {
		try {
			await invoke('open_local_url', { url: `http://localhost:${port}` });
		} catch (e) {
			status.flash(`เปิดเบราว์เซอร์ไม่ได้: ${e}`, 5000);
		}
	}
}

export const system = new SystemStats();
