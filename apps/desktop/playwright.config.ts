import { defineConfig } from '@playwright/test';

// UI end-to-end against the Vite build with Tauri IPC mocked (e2e/mock.ts) — plus one bridge
// door (e2e/live-bridge.ts) whose `agent_list_models` is answered by the real agent host and the
// installed CLIs (e2e/models-probe-live.spec.ts is the only consumer). The Rust domains are
// covered by cargo tests; this suite proves the webview wiring: boot, workbench, editor, chat,
// panel, every Activity Bar view, ADE tasks and Settings.
export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:4174',
		channel: 'chrome',
		locale: 'en-US',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	webServer: [
		{
			command: 'bun run dev -- --port 4174',
			url: 'http://localhost:4174',
			reuseExistingServer: false,
			timeout: 120_000
		},
		{
			command: 'bun e2e/live-bridge.ts',
			url: 'http://127.0.0.1:4179',
			timeout: 120_000
		}
	]
});
