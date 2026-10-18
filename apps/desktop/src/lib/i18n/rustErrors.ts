// Rust errors the webview reacts to (offer Install, Open in Terminal, gh setup help), matched by
// their text in either UI language: Rust writes them in the language it was set to when the
// command ran, which may not be the one shown now. Each entry is the start of the Rust catalog
// message(s) listed in `src-tauri/src/i18n/msg/mod.rs` `frontend_matched()`; a Rust test
// (`i18n::tests::frontend_error_prefixes_are_the_catalog_text`) fails if they drift apart.
// Keep one entry per line in this exact shape — the Rust test parses it.

export const RUST_ERRORS = {
	ghMissing: { en: 'GitHub CLI (gh) not found', th: 'ไม่พบ GitHub CLI (gh)' },
	remoteAuthFailed: { en: 'Authentication with the remote failed', th: 'ยืนยันตัวตนกับ remote ไม่สำเร็จ' },
	notInstalled: { en: 'Not installed: ', th: 'ไม่ได้ติดตั้ง ' }
} as const;

export type RustErrorId = keyof typeof RUST_ERRORS;

/** Whether `error` (a rejected invoke, an Error or a string) is the Rust error `id`, in either language. */
export function isRustError(error: unknown, id: RustErrorId): boolean {
	const text = error instanceof Error ? error.message : String(error);
	const { en, th } = RUST_ERRORS[id];
	return text.includes(en) || text.includes(th);
}
