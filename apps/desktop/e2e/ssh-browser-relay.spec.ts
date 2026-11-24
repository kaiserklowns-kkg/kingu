import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers';
import { watchErrors } from './mock';

// Browser tools for an agent on an SSH host (Rust ssh_browser_relay.rs, ade/sshBrowserRelay.ts;
// Orca 1.4.272's desktop browser bridge): before the host's agent opens a page or loads an address
// in Kingu's browser, Rust asks the window over the `kingu` request bridge and waits for the answer.

/** Records what the window answers Rust (`cli_reply`), keeping the mock's own handling. */
async function captureReplies(page: Page) {
	await page.evaluate(() => {
		const internals = (window as any).__TAURI_INTERNALS__;
		const invoke = internals.invoke;
		(window as any).__replies = [];
		internals.invoke = (cmd: string, args?: any) => {
			if (cmd === 'cli_reply') (window as any).__replies.push(args);
			return invoke(cmd, args);
		};
	});
}

async function ask(page: Page, id: number, params: object) {
	await page.evaluate(({ id, params }) => (window as any).__e2e.emit('kingu-cli:request', { id, method: 'browser.relayGrant', params }), { id, params });
	await expect.poll(() => page.evaluate((id) => (window as any).__replies.find((r: { id: number }) => r.id === id) ?? null, id)).not.toBeNull();
	return page.evaluate((id) => (window as any).__replies.find((r: { id: number }) => r.id === id), id);
}

test('an SSH host agent opening a page or loading an address is asked first', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, undefined, { 'kingu.browser.agentTools': true });
	await captureReplies(page);

	// Allow for This Run.
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 1));
	const run = await ask(page, 41, { host: 'box', url: 'https://a.dev/', kind: 'open', run: 'abcdef12' });
	expect(run).toEqual({ id: 41, result: { answer: 'run' }, error: null });
	const asked = await page.evaluate(() => (window as any).__e2e.messages.at(-1));
	expect(asked.title).toBe('Open Browser Page for an SSH Agent?');
	expect(asked.message).toContain('box');
	expect(asked.message).toContain('https://a.dev/');
	expect(asked.buttons).toEqual(['Allow Once', 'Allow for This Run', 'Deny']);

	// Deny a navigation.
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 2));
	const denied = await ask(page, 42, { host: 'box', url: 'https://b.dev/', kind: 'navigate', run: 'abcdef12' });
	expect(denied.result).toEqual({ answer: 'deny' });
	expect(await page.evaluate(() => (window as any).__e2e.messages.at(-1).title)).toBe('Navigate Browser for an SSH Agent?');

	// Escape (no button) declines too.
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = null));
	expect((await ask(page, 43, { host: 'box', url: 'https://c.dev/', kind: 'open', run: 'abcdef12' })).result).toEqual({ answer: 'deny' });
	expect(errors).toEqual([]);
});
