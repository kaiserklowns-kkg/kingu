import { expect, test } from '@playwright/test';
import { calls, openApp, openSettings } from './helpers';
import { watchErrors } from './mock';

test('turning on chat-history cleanup asks first; Codex history size shows beside it', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openSettings(page);
	await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Workspace Cleanup', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Chat history', exact: true })).toBeVisible();
	// The badge: Codex has history on this computer (workspace_cleanup_codex_history_usage).
	await expect(page.getByText(/^Codex history: /)).toBeVisible();

	const toggle = page.getByRole('switch', { name: 'Delete agent history of deleted workspaces' });
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	const messages = () => page.evaluate(() => (window as any).__e2e.messages as { title: string; buttons: string[] }[]);
	const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('__kingu_e2e_settings') ?? '{}')['kingu.workspaceCleanup.deleteChatHistory']);

	// Cancel in the confirmation keeps it off.
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 1));
	await toggle.click();
	await expect.poll(async () => (await messages()).length).toBe(1);
	expect((await messages())[0]).toMatchObject({ title: 'Delete agent history from deleted workspaces?', buttons: ['Turn on', 'Cancel'] });
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	expect(await saved()).toBeUndefined();

	// Turn on: saved, and the open folder is swept at once.
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 0));
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-checked', 'true');
	await expect.poll(saved).toBe(true);
	await expect.poll(async () => (await calls(page)).workspace_cleanup_chat_sweep ?? 0).toBeGreaterThan(0);

	// Turning it off does not ask.
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	expect(await messages()).toHaveLength(2);
	expect(errors).toEqual([]);
});
