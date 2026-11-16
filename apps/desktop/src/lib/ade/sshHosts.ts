// SSH Hosts: the shapes Rust's ssh_hosts.rs uses and the parsing of what the user types. Pure.

export type SshTarget = {
	id: string;
	label: string;
	config_host: string | null;
	host: string;
	port: number;
	username: string;
	identity_file: string | null;
	jump_host: string | null;
	proxy_command: string | null;
};

const port = (s: string | undefined, fallback: number): number | null => {
	if (s === undefined || s === '') return fallback;
	if (!/^\d{1,5}$/.test(s)) return null;
	const n = Number(s);
	return n >= 1 && n <= 65535 ? n : null;
};

/** `user@host:port`, `host:port`, `user@host`, `host` (IPv6 in brackets: `[::1]:22`). */
export function parseDestination(text: string): { username: string; host: string; port: number } | null {
	const t = text.trim();
	if (!t || /\s/.test(t) || t.startsWith('-')) return null;
	const at = t.lastIndexOf('@');
	const username = at >= 0 ? t.slice(0, at) : '';
	const rest = at >= 0 ? t.slice(at + 1) : t;
	if (at >= 0 && (!username || username.includes('@'))) return null;
	const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest) ?? /^([^:]+)(?::(\d+))?$/.exec(rest);
	if (!m || !m[1] || m[1].startsWith('-')) return null;
	const p = port(m[2], 22);
	return p === null ? null : { username, host: m[1], port: p };
}

/** `3000` (same port on the remote machine's localhost), `3000:5173`, or `3000:host:5173`. */
export function parseForward(text: string): { local: number; host: string; remote: number } | null {
	const parts = text.trim().split(':');
	if (parts.length === 1) {
		const p = port(parts[0], -1);
		return p && p > 0 ? { local: p, host: 'localhost', remote: p } : null;
	}
	if (parts.length === 2) {
		const [l, r] = [port(parts[0], -1), port(parts[1], -1)];
		return l && l > 0 && r && r > 0 ? { local: l, host: 'localhost', remote: r } : null;
	}
	if (parts.length === 3) {
		const [l, r] = [port(parts[0], -1), port(parts[2], -1)];
		const host = parts[1]!.trim();
		return l && l > 0 && r && r > 0 && host && !host.startsWith('-') && !/\s/.test(host) ? { local: l, host, remote: r } : null;
	}
	return null;
}
