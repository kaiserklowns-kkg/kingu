// The sandbox's allowed / denied network domains (`chat.agent.sandbox.network.allowedDomains`,
// `chat.agent.sandbox.network.deniedDomains`; VS Code's src/vs/platform/networkFilter/common/settings.ts
// `AgentNetworkDomainSettingId`, the agent host keys `allowedNetworkDomains` / `deniedNetworkDomains`
// in src/vs/platform/agentHost/common/sandboxConfigSchema.ts).
//
// Patterns are VS Code's (src/vs/platform/networkFilter/common/domainMatcher.ts): a host, `*.host`
// (the host and every subdomain), `*` (any host), a URL (its authority counts), an IP literal.
// `normalizeDomainPattern` and `matchesDomainPattern` are ported from there; a pattern VS Code
// cannot normalize makes its Local harness block all network (terminalSandboxEngine.ts
// `_getNormalizedNetworkDomains`), and Kingu refuses the run instead (config.ts), as it does
// for every sandbox value that does not fit.

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?))*$/;

/** VS Code's `normalizeDomain(value, fromUrl = true)`: lower case, no user info, port or trailing dot. */
function normalizeDomain(value: string): string | undefined {
	const n = value.trim().toLowerCase().replace(/^[^@]+@/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
	if (!n || n.includes('/') || n === '.' || n === '..') return undefined;
	if (n === '*') return '*';
	if (!/^\*?\.?[a-z0-9.;,)!?:-]+$/.test(n)) return undefined;
	const stripped = n.replace(/[),;:!?]+$/, '');
	if (!stripped) return undefined;
	const wild = stripped.startsWith('*.');
	const host = wild ? stripped.slice(2) : stripped;
	if (!host || !DOMAIN.test(host)) return undefined;
	return wild ? `*.${host}` : host;
}

/** The host of `authority` (`host[:port]`, an IPv6 literal in brackets), lower case. */
function authorityHost(authority: string): string | undefined {
	if (!authority || /[/?#\\]/.test(authority)) return undefined;
	let hostname: string;
	try {
		const url = new URL(`http://${authority}`);
		if (url.username || url.password) return undefined;
		hostname = url.hostname.toLowerCase();
	} catch {
		return undefined;
	}
	if (hostname.startsWith('[')) return hostname.endsWith(']') ? hostname : undefined;
	return normalizeDomain(hostname);
}

/** A bare IPv6 address as `[addr]`, normalized. */
function bareIpv6(value: string): string | undefined {
	if (!value.includes(':') || /[/?#\\@[\]]/.test(value)) return undefined;
	return authorityHost(`[${value}]`);
}

/** The authority of a pattern written as a URL, else the pattern. */
function extract(pattern: string): string {
	const t = pattern.trim();
	if (t === '*' || !t.includes('://')) return t;
	try {
		return new URL(t).host;
	} catch {
		return t;
	}
}

/** VS Code's `normalizeDomainPattern`: the canonical form of a pattern, or undefined when it is not one. */
export function normalizeDomainPattern(pattern: string): string | undefined {
	const p = extract(pattern);
	if (p === '*') return p;
	if (p.startsWith('*.')) {
		const suffix = authorityHost(p.slice(2));
		const n = normalizeDomain(suffix ? `*.${suffix}` : p);
		return n ? `*.${authorityHost(n.slice(2)) ?? n.slice(2)}` : undefined;
	}
	return bareIpv6(p) ?? authorityHost(p) ?? normalizeDomain(p);
}

/** `[::ffff:a.b.c.d]` (and the old compatible form) as the IPv4 address it carries. */
function embeddedIpv4(value: string): string | undefined {
	const mapped = /^\[::ffff:(?<high>[0-9a-f]{1,4}):(?<low>[0-9a-f]{1,4})\]$/.exec(value);
	const compat = mapped ? undefined : /^\[::(?:(?<high>[0-9a-f]{1,4}):)?(?<low>[0-9a-f]{1,4})\]$/.exec(value);
	const g = (mapped ?? compat)?.groups;
	if (!g) return undefined;
	const high = Number.parseInt(g.high ?? '0', 16);
	const low = Number.parseInt(g.low!, 16);
	if (compat && high === 0 && low <= 1) return undefined;
	return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

/** VS Code's `matchesDomainPattern` for an already normalized pattern. */
export function matchesNormalized(host: string, pattern: string): boolean {
	if (pattern === '*') return true;
	const h = embeddedIpv4(host) ?? host;
	if (pattern.startsWith('*.')) {
		const suffix = pattern.slice(2);
		return h === suffix || h.endsWith(`.${suffix}`);
	}
	return h === (embeddedIpv4(pattern) ?? pattern);
}

/** The host a proxy request names (`example.com`, `[::1]`, `1.2.3.4`) in the matcher's form, or undefined. */
export function requestHost(host: string): string | undefined {
	const h = host.trim().toLowerCase().replace(/\.+$/, '');
	if (!h) return undefined;
	if (h.startsWith('[')) return authorityHost(h);
	if (h.includes(':')) return bareIpv6(h);
	return authorityHost(h);
}

export type DomainRules = {
	/** `network.allowNetwork`. */
	open: boolean;
	/** Normalized allowed patterns. */
	allowed: readonly string[];
	/** Normalized denied patterns. */
	denied: readonly string[];
};

/**
 * Whether a sandboxed command may reach `host` (normalized by `requestHost`). Denied always wins.
 * An allow list, when there is one, is the only way out. Without one, the network setting decides.
 *
 * VS Code's two harnesses differ here and this takes the stricter reading of each:
 * - network on: the Local harness ignores both lists (terminalSandboxEngine.ts `_createSandboxConfig`,
 *   `network: { enabled: false }`), the Copilot agent host forwards them as host rules
 *   (sandboxConfigForSdk.ts `allowedHosts` / `blockedHosts`) and the setting says "Configured allowed
 *   and denied network domains still restrict destinations": they restrict.
 * - network off: the Local harness lets the allowed domains through its proxy
 *   (`getResolvedNetworkDomains`); the agent host's text says the list "does not enable outbound
 *   access". Kingu follows the Local harness, the one whose behaviour Arkai's Bash copies.
 */
export function hostAllowed(host: string, r: DomainRules): boolean {
	if (r.denied.some((p) => matchesNormalized(host, p))) return false;
	if (r.allowed.length) return r.allowed.some((p) => matchesNormalized(host, p));
	return r.open;
}

/** Whether the run's network needs Kingu's filtering proxy (a list changes what may be reached). */
export const needsProxy = (r: DomainRules) => r.allowed.length > 0 || (r.open && r.denied.length > 0);
