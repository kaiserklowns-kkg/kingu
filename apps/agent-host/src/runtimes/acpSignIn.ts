// Signing an ACP agent in from the chat (Orca `main/antigravity/antigravity-sign-in-url.ts`,
// `antigravity-chat-sign-in.ts`, `antigravity-browser-helper.ts`). Kingu never handles the
// credential: the agent runs Google's OAuth itself.
//
// - `browser` (Kingu's Antigravity ACP server): Sign in sends ACP `authenticate` with the
//   agent's method; the server starts Google's sign-in with a loopback redirect and either prints
//   the link (`Open the following link to authenticate the ACP server: <url>`) or hands it to
//   `BROWSER`, which Rust points at a helper that prints it after a marker on stderr. Only a Google
//   OAuth URL that returns to a loopback port on this machine is shown; the chat opens it on the
//   user's click. The line is never shown as agent output.
// - `terminal` (the host's `agy acp`): the agent's own login in a terminal; the chat's Sign in
//   then asks the agent again.

export const SIGN_IN_PROMPT = 'Open the following link to authenticate the ACP server: ';
/** Rust agent/antigravity.rs `BROWSER_MARKER`. */
export const BROWSER_MARKER = '__KINGU_ANTIGRAVITY_AUTH_URL__';

const MAX_URL_CHARS = 16_384;

/** A Google sign-in URL that returns to a loopback port here (Orca `antigravitySignInUrl`); else null. */
export function signInUrl(link: string): string | null {
	if (link.length > MAX_URL_CHARS || /\s/.test(link) || !URL.canParse(link)) return null;
	const url = new URL(link);
	const one = (name: string) => (url.searchParams.getAll(name).length === 1 ? (url.searchParams.get(name) ?? '') : '');
	const redirect = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/.exec(one('redirect_uri'));
	const port = Number(redirect?.[1]);
	const valid =
		url.origin === 'https://accounts.google.com' &&
		url.pathname === '/o/oauth2/v2/auth' &&
		!url.username &&
		!url.password &&
		!url.hash &&
		one('response_type') === 'code' &&
		/^\S{1,512}$/.test(one('state')) &&
		port >= 1024 &&
		port <= 65_535;
	return valid ? link : null;
}

/**
 * A line of the agent's output: the sign-in link it carries, `null` for a sign-in line whose link
 * is not one Kingu shows, `undefined` for any other line (Orca `readAntigravitySignInLine`).
 */
export function readSignInLine(line: string, source: 'stdout' | 'stderr'): string | null | undefined {
	const text = line.endsWith('\r') ? line.slice(0, -1) : line;
	let link: string;
	if (text.startsWith(SIGN_IN_PROMPT)) link = text.slice(SIGN_IN_PROMPT.length);
	else if (source === 'stderr' && text.startsWith(BROWSER_MARKER)) link = text.slice(BROWSER_MARKER.length);
	else return undefined;
	return signInUrl(link.trim());
}

/** How the chat signs an agent in (acpDialects.ts `signIn`). */
export type SignInVia = { via: 'browser'; method: string } | { via: 'terminal'; login: string[] };

/** Where a sign-in stands (`sign_in` events; the chat's sign-in card). */
export type SignInState = 'required' | 'starting' | 'waiting' | 'verifying' | 'signed_in' | 'failed';

/** Orca's browser wait: a sign-in nobody finishes ends after five minutes. */
export const SIGN_IN_TIMEOUT_MS = 300_000;
