import { invoke } from '@tauri-apps/api/core';

export function clientLog(level: 'info' | 'error', message: string): void {
	invoke('client_log', { level, message }).catch(() => {});
}

export function forwardWindowErrors(): () => void {
	const onError = (e: ErrorEvent) => clientLog('error', `${e.message} (${e.filename}:${e.lineno})`);
	const onRejection = (e: PromiseRejectionEvent) => clientLog('error', `unhandled rejection: ${String(e.reason)}`);
	window.addEventListener('error', onError);
	window.addEventListener('unhandledrejection', onRejection);
	return () => {
		window.removeEventListener('error', onError);
		window.removeEventListener('unhandledrejection', onRejection);
	};
}
