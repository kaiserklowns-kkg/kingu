// Who opens a web link clicked in a Monaco editor (monaco.ts registers the opener once Monaco
// loads; trustedDomains.svelte.ts sets the handler, which asks before opening an untrusted
// domain). The handler answers whether it took the link; Monaco handles the others.

let handler: ((url: string) => boolean) | null = null;

export function setEditorLinkHandler(fn: ((url: string) => boolean) | null) {
	handler = fn;
}

export function openEditorLink(url: string): boolean {
	return handler?.(url) ?? false;
}
