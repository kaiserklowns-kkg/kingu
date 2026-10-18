import { invoke } from '@tauri-apps/api/core';

export function clientLog(level: 'info' | 'error', message: string): void {
	invoke('client_log', { level, message }).catch(() => {});
}

export function forwardWindowErrors(): () => void {
	const onError = (e: ErrorEvent) => clientLog('error', `${e.message} (${e.filename}:${e.lineno})`);
	// Monaco rejects a diff computation that a closed or replaced diff editor cancelled: not an error.
	const BENIGN = ['no diff result available'];
	const onRejection = (e: PromiseRejectionEvent) => {
		const text = String(e.reason);
		if (BENIGN.some((b) => text.includes(b))) return e.preventDefault();
		clientLog('error', `unhandled rejection: ${text}`);
	};
	window.addEventListener('error', onError);
	window.addEventListener('unhandledrejection', onRejection);
	return () => {
		window.removeEventListener('error', onError);
		window.removeEventListener('unhandledrejection', onRejection);
	};
}
