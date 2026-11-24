// The run's network filter for sandboxed commands when a domain list applies
// (`chat.agent.sandbox.network.allowedDomains` / `deniedDomains`, domains.ts). VS Code's Local
// harness hands the lists to the sandbox runtime, whose proxy the command must go through
// (terminalSandboxEngine.ts `getResolvedNetworkDomains`); Kingu runs its own: an HTTP proxy on
// loopback that the Seatbelt profile leaves as the command's only IP destination (profile.ts),
// named in the command's `HTTP(S)_PROXY` / `ALL_PROXY`.
//
// - `CONNECT host:port` (HTTPS, and any TLS or TCP a client tunnels) and absolute-form plain HTTP
//   requests. The proxy never decrypts: it sees the host a client asks for, and nothing else.
// - SOCKS5 CONNECT on the same port (the first byte tells them apart), for what is not HTTP: the
//   sandbox runtime runs a SOCKS listener next to its HTTP one and points `ALL_PROXY` and git's ssh
//   at it (`GIT_SSH_COMMAND=ssh -o ProxyCommand='nc -X 5 -x …'` on macOS; sandbox-utils.js
//   `generateProxyEnvVars`, socks-proxy.js). So `git@github.com:` remotes, `ssh` and `rsync` reach
//   an allowed host on any port, under the same rules; a denied one gets RFC 1928's "not allowed".
// - The host must pass `hostAllowed`; then it is resolved here (the command cannot resolve names:
//   DNS is closed to it) and refused when any of its addresses is loopback, private or link-local
//   unless `allowLocalNetwork` (VS Code's setting text: "The local proxy checks destination
//   addresses for direct connections"). The connection goes to the address that was checked.
// - An `http://` upstream proxy in the host's environment (`HTTPS_PROXY`, …, as Rust sets from
//   `http.proxy`) is used for allowed hosts, outside `NO_PROXY`; the upstream resolves the name
//   then ("An upstream proxy resolves its own destinations"). Other upstream schemes: direct.
// - Refusals are `403` with a body naming the host and the setting. Nothing is logged: request
//   headers can carry tokens.
// - No credential is injected (`injectHosts`): that would need this proxy to decrypt TLS with a
//   CA the command trusts. See docs/ADE-PARITY.md item 7.

import { lookup } from 'node:dns/promises';
import { isIP, connect, createServer, type Server, type Socket } from 'node:net';
import { hostAllowed, requestHost, type DomainRules } from './domains.ts';

const MAX_HEAD = 64 * 1024;
const HEAD_TIMEOUT_MS = 30_000;

export type Resolve = (host: string) => Promise<string[]>;
export type Upstream = { host: string; port: number; auth: string | null; noProxy: string[] };

const defaultResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** An IPv4 or IPv6 address on this machine or the local network (loopback, private, link-local, unspecified, multicast). */
export function isLocalAddress(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) {
		const [a, b] = ip.split('.').map(Number) as [number, number];
		return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
	}
	if (v === 6) {
		const x = ip.toLowerCase();
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
		if (mapped) return isLocalAddress(mapped[1]!);
		return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
	}
	return true;
}

/** The `http://` upstream proxy in `env`, or null (none, or a scheme this proxy cannot speak). */
export function upstreamFrom(env: Record<string, string | undefined>): Upstream | null {
	const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' || !url.hostname) return null;
	const user = decodeURIComponent(url.username);
	const auth = user || url.password ? `Basic ${Buffer.from(`${user}:${decodeURIComponent(url.password)}`).toString('base64')}` : null;
	const noProxy = (env.NO_PROXY || env.no_proxy || '')
		.split(',')
		.map((s) => s.trim().toLowerCase().replace(/^\*?\./, '.'))
		.filter(Boolean);
	return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80), auth, noProxy };
}

const bypass = (u: Upstream, host: string) => u.noProxy.some((n) => n === '*' || host === n.replace(/^\./, '') || (n.startsWith('.') ? host.endsWith(n) : host.endsWith(`.${n}`)));

/**
 * What a socket sent before its tunnel opens (an HTTP head, a SOCKS handshake), read in steps.
 * Gives up (null) when the peer goes away, sends more than `MAX_HEAD` or takes too long.
 */
class Incoming {
	private buf = Buffer.alloc(0);
	private ended = false;
	private wake: (() => void) | null = null;
	private readonly timer: ReturnType<typeof setTimeout>;

	constructor(private readonly sock: Socket) {
		sock.on('data', this.onData);
		sock.once('close', this.onEnd);
		sock.once('error', this.onEnd);
		this.timer = setTimeout(this.onEnd, HEAD_TIMEOUT_MS);
		sock.resume();
	}

	private onData = (chunk: Buffer) => {
		this.buf = Buffer.concat([this.buf, chunk]);
		if (this.buf.length > MAX_HEAD) this.ended = true;
		this.kick();
	};
	private onEnd = () => {
		this.ended = true;
		this.kick();
	};
	private kick() {
		const w = this.wake;
		this.wake = null;
		w?.();
	}
	private async until(ok: () => boolean): Promise<boolean> {
		while (!ok()) {
			if (this.ended) return false;
			await new Promise<void>((r) => (this.wake = r));
		}
		return true;
	}

	/** The next byte, without taking it. */
	async peek(): Promise<number | null> {
		return (await this.until(() => this.buf.length > 0)) ? this.buf[0]! : null;
	}

	/** The next `n` bytes. */
	async take(n: number): Promise<Buffer | null> {
		if (!(await this.until(() => this.buf.length >= n))) return null;
		const out = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(n);
		return out;
	}

	/** An HTTP head, up to the blank line. */
	async head(): Promise<string | null> {
		let end = -1;
		if (!(await this.until(() => (end = this.buf.indexOf('\r\n\r\n')) >= 0))) return null;
		const head = this.buf.subarray(0, end).toString('latin1');
		this.buf = this.buf.subarray(end + 4);
		return head;
	}

	/** Stops reading (the socket pauses) and gives back what came after the last step. */
	release(): Buffer {
		clearTimeout(this.timer);
		this.sock.off('data', this.onData);
		this.sock.off('close', this.onEnd);
		this.sock.off('error', this.onEnd);
		this.sock.pause();
		return this.buf;
	}
}

function reply(sock: Socket, status: string, body: string) {
	sock.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}\n`);
}

const refusal = (host: string) => `Kingu sandbox: network access blocked: ${host} is not allowed by chat.agent.sandbox.network.allowedDomains / deniedDomains.`;
const localRefusal = (host: string) => `Kingu sandbox: network access blocked: ${host} is on this machine or the local network (chat.agent.sandbox.network.allowLocalNetwork is off).`;

function openSocket(host: string, port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const s = connect({ host, port });
		s.once('connect', () => (s.off('error', reject), resolve(s)));
		s.once('error', reject);
	});
}

function pipeBoth(a: Socket, b: Socket) {
	a.pipe(b);
	b.pipe(a);
	const close = () => {
		a.destroy();
		b.destroy();
	};
	a.once('error', close);
	b.once('error', close);
	a.once('close', close);
	b.once('close', close);
	a.resume();
	b.resume();
}

/** Headers of a forwarded plain HTTP request, without the proxy's own and with one request per connection. */
function forwardHeaders(lines: string[], extra: string[]): string {
	const kept = lines.filter((l) => !/^(proxy-[a-z-]*|connection|keep-alive)\s*:/i.test(l));
	return [...kept, ...extra, 'Connection: close'].join('\r\n');
}

/**
 * `resolve` and `isLocal` are for tests (a fake name pointing at a local server). `onRefused`: a
 * host the rules or the local-network check refused (retry.ts offers to allow it).
 */
export type ProxyOptions = {
	rules: DomainRules;
	localNetwork: boolean;
	upstream?: Upstream | null;
	resolve?: Resolve;
	isLocal?: (ip: string) => boolean;
	onRefused?: (host: string, why: 'denied' | 'local') => void;
};

/** A running filter proxy on 127.0.0.1. */
export class DomainProxy {
	private constructor(
		private readonly server: Server,
		readonly port: number,
		private readonly o: ProxyOptions
	) {}

	static start(options: ProxyOptions): Promise<DomainProxy> {
		// Its own copy: `setRules` changes what the next connection is checked against.
		const o = { ...options };
		const server = createServer((sock) => void handle(sock, o).catch(() => sock.destroy()));
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address();
				if (!addr || typeof addr === 'string') return reject(new Error('the sandbox proxy has no port'));
				resolve(new DomainProxy(server, addr.port, o));
			});
		});
	}

	/**
	 * The variables that point a command's clients here, as the sandbox runtime sets them for its
	 * HTTP and SOCKS listeners (sandbox-utils.js `generateProxyEnvVars`); both are this one port.
	 * `GIT_SSH_COMMAND` makes git's ssh (and `eval "$GIT_SSH_COMMAND" host`) tunnel through it:
	 * BSD nc's SOCKS5 on macOS, socat's HTTP CONNECT on Linux, as the runtime does.
	 */
	env(localNetwork: boolean, platform: string = process.platform): Record<string, string> {
		const at = `127.0.0.1:${this.port}`;
		const url = `http://${at}`;
		const socks = `socks5h://${at}`;
		const noProxy = localNetwork ? 'localhost,127.0.0.1,::1' : '';
		const sshProxy = platform === 'darwin' ? `/usr/bin/nc -X 5 -x ${at} %h %p` : platform === 'linux' ? `socat - PROXY:127.0.0.1:%h:%p,proxyport=${this.port}` : null;
		return {
			HTTP_PROXY: url,
			HTTPS_PROXY: url,
			ALL_PROXY: socks,
			http_proxy: url,
			https_proxy: url,
			all_proxy: socks,
			NO_PROXY: noProxy,
			no_proxy: noProxy,
			RSYNC_PROXY: at,
			...(sshProxy ? { GIT_SSH_COMMAND: `ssh -o ProxyCommand='${sshProxy}'` } : {})
		};
	}

	/** The rules after the user allowed more for the rest of the run (retry.ts); open connections stay. */
	setRules(rules: DomainRules) {
		this.o.rules = rules;
	}

	close() {
		this.server.close();
	}
}

type Refusal = 'bad' | 'denied' | 'local' | 'unresolved' | 'upstream' | 'unreachable';
type Dialed = { ok: true; sock: Socket; via: Upstream | null; rest: Buffer } | { ok: false; why: Refusal; host: string; status?: string };

/**
 * A connection to `hostname:port` for a client, after the checks every way in shares (HTTP,
 * CONNECT, SOCKS5): the host passes the domain rules, then resolves outside the local network
 * unless `localNetwork`, or goes through the upstream proxy. `tunnel`: the upstream, if any, is
 * asked for a CONNECT tunnel (else the caller forwards a plain HTTP request to it).
 */
async function dial(hostname: string, port: number, tunnel: boolean, o: ProxyOptions): Promise<Dialed> {
	// SOCKS names are raw bytes: no control characters or spaces reach the matcher.
	const host = /[^\x21-\x7e]/.test(hostname) ? undefined : requestHost(hostname);
	if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: 'bad', host: hostname };
	if (!hostAllowed(host, o.rules)) {
		o.onRefused?.(host, 'denied');
		return { ok: false, why: 'denied', host };
	}
	const bare = host.replace(/^\[|\]$/g, '');
	const up = o.upstream && !bypass(o.upstream, bare) ? o.upstream : null;
	try {
		if (up) {
			const sock = await openSocket(up.host, up.port);
			if (!tunnel) return { ok: true, sock, via: up, rest: Buffer.alloc(0) };
			sock.on('error', () => {});
			const target = `${host}:${port}`;
			sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${up.auth ? `Proxy-Authorization: ${up.auth}\r\n` : ''}\r\n`);
			const res = new Incoming(sock);
			const head = await res.head();
			const status = head ? /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] : undefined;
			const rest = res.release();
			if (status !== '200') {
				sock.destroy();
				return { ok: false, why: 'upstream', host, status: status ?? 'no answer' };
			}
			return { ok: true, sock, via: up, rest };
		}
		const addrs = isIP(bare) ? [bare] : await (o.resolve ?? defaultResolve)(bare).catch(() => []);
		if (!addrs.length) return { ok: false, why: 'unresolved', host };
		if (!o.localNetwork && addrs.some(o.isLocal ?? isLocalAddress)) {
			o.onRefused?.(host, 'local');
			return { ok: false, why: 'local', host };
		}
		return { ok: true, sock: await openSocket(addrs[0]!, port), via: null, rest: Buffer.alloc(0) };
	} catch {
		return { ok: false, why: 'unreachable', host };
	}
}

function refuseHttp(client: Socket, d: Extract<Dialed, { ok: false }>) {
	switch (d.why) {
		case 'bad':
			return reply(client, '400 Bad Request', 'Kingu sandbox: not a host name.');
		case 'denied':
			return reply(client, '403 Forbidden', refusal(d.host));
		case 'local':
			return reply(client, '403 Forbidden', localRefusal(d.host));
		case 'unresolved':
			return reply(client, '502 Bad Gateway', `Kingu sandbox: could not resolve host ${d.host}.`);
		case 'upstream':
			return reply(client, '502 Bad Gateway', `Kingu sandbox: the upstream proxy refused ${d.host} (${d.status}).`);
		case 'unreachable':
			return reply(client, '502 Bad Gateway', `Kingu sandbox: could not connect to ${d.host}.`);
	}
}

async function handle(client: Socket, o: ProxyOptions) {
	client.on('error', () => {});
	const inc = new Incoming(client);
	// A SOCKS5 greeting starts with its version byte; an HTTP request with a letter.
	const first = await inc.peek();
	if (first === null) return void (inc.release(), client.destroy());
	if (first === SOCKS5) return socks(client, inc, o);
	const head = await inc.head();
	if (head === null) return void (inc.release(), client.destroy());
	const [line = '', ...headerLines] = head.split('\r\n');
	const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
	if (!m) return void (inc.release(), reply(client, '400 Bad Request', 'Kingu sandbox: not an HTTP proxy request.'));
	const [, method, target] = m as unknown as [string, string, string];
	let hostname: string;
	let port: number;
	let path = '/';
	if (method === 'CONNECT') {
		const hm = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
		if (!hm) return void (inc.release(), reply(client, '400 Bad Request', 'Kingu sandbox: CONNECT needs host:port.'));
		hostname = hm[1]!;
		port = Number(hm[2]);
	} else {
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			return void (inc.release(), reply(client, '400 Bad Request', 'Kingu sandbox: send requests through the proxy with a full http:// URL.'));
		}
		if (url.protocol !== 'http:') return void (inc.release(), reply(client, '400 Bad Request', 'Kingu sandbox: only http:// requests and CONNECT tunnels go through this proxy.'));
		hostname = url.hostname;
		port = Number(url.port || 80);
		path = `${url.pathname}${url.search}`;
	}
	const d = await dial(hostname, port, method === 'CONNECT', o);
	const rest = inc.release();
	if (!d.ok) return refuseHttp(client, d);
	if (method === 'CONNECT') {
		client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		if (d.rest.length) client.write(d.rest);
	} else if (d.via) {
		d.sock.write(`${method} ${target} HTTP/1.1\r\n${forwardHeaders(headerLines, d.via.auth ? [`Proxy-Authorization: ${d.via.auth}`] : [])}\r\n\r\n`);
	} else {
		d.sock.write(`${method} ${path} HTTP/1.1\r\n${forwardHeaders(headerLines, [])}\r\n\r\n`);
	}
	if (rest.length) d.sock.write(rest);
	pipeBoth(client, d.sock);
}

const SOCKS5 = 0x05;
/** RFC 1928 reply codes. */
const SOCKS_REPLY: Record<Refusal | 'ok' | 'command' | 'address', number> = { ok: 0, bad: 1, upstream: 1, denied: 2, local: 2, unresolved: 4, unreachable: 5, command: 7, address: 8 };

function socksReply(client: Socket, code: number) {
	const r = Buffer.from([SOCKS5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
	if (code === 0) client.write(r);
	else client.end(r);
}

/** An IPv6 address from its 16 bytes, in brackets. */
const ipv6 = (b: Buffer) => `[${Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':')}]`;

/**
 * A SOCKS5 client (RFC 1928): no authentication, CONNECT only, any address type. The
 * sandbox runtime's SOCKS listener (socks-proxy.js) does the same and checks the destination
 * with the same filter as its HTTP proxy; the refusal is "connection not allowed by ruleset".
 */
async function socks(client: Socket, inc: Incoming, o: ProxyOptions) {
	const fail = () => void (inc.release(), client.destroy());
	const greet = await inc.take(2);
	if (!greet || greet[0] !== SOCKS5) return fail();
	const methods = await inc.take(greet[1]!);
	if (!methods) return fail();
	if (!methods.includes(0)) return void (inc.release(), client.end(Buffer.from([SOCKS5, 0xff])));
	client.write(Buffer.from([SOCKS5, 0]));
	const req = await inc.take(4);
	if (!req || req[0] !== SOCKS5) return fail();
	let hostname: string | null = null;
	if (req[3] === 1) hostname = (await inc.take(4))?.join('.') ?? null;
	else if (req[3] === 3) {
		const len = await inc.take(1);
		hostname = len ? ((await inc.take(len[0]!))?.toString('latin1') ?? null) : null;
	} else if (req[3] === 4) {
		const b = await inc.take(16);
		hostname = b ? ipv6(b) : null;
	} else return void (inc.release(), socksReply(client, SOCKS_REPLY.address));
	const portBytes = hostname === null ? null : await inc.take(2);
	if (hostname === null || !portBytes) return fail();
	if (req[1] !== 1) return void (inc.release(), socksReply(client, SOCKS_REPLY.command));
	const d = await dial(hostname, portBytes.readUInt16BE(0), true, o);
	const rest = inc.release();
	if (!d.ok) return socksReply(client, SOCKS_REPLY[d.why]);
	socksReply(client, SOCKS_REPLY.ok);
	if (d.rest.length) client.write(d.rest);
	if (rest.length) d.sock.write(rest);
	pipeBoth(client, d.sock);
}
