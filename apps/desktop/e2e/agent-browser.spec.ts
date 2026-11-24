import { expect, test, type Page } from '@playwright/test';
import { openApp, runCommand } from './helpers';
import { watchErrors } from './mock';

// Agent browser use (workbench/agentBrowser.svelte.ts, Rust floating_browser/agent.rs): VS Code
// 1.147's Share with Agent, the tab's indicator with Stop, Kingu's action log with Replay, Add
// Screenshot to Chat and Add Context's Browser Screenshot.

async function openBrowserTab(page: Page) {
	await runCommand(page, 'Toggle Floating Terminal');
	const panel = page.getByRole('region', { name: 'Floating workspace' });
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: 'New tab' }).click();
	await page.getByRole('menuitem', { name: /New Browser/ }).click();
	await expect(panel.getByRole('textbox', { name: 'Address' })).toBeVisible();
	return panel;
}

/** Chat: Add Context... from the command palette, then its Browser Screenshot row (the same quick input). */
async function addBrowserScreenshot(page: Page) {
	await page.getByRole('banner').getByRole('button', { name: /Open Quick Access/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Quick open' });
	await dialog.locator('input').fill('>Chat: Add Context...');
	await dialog.getByRole('option').first().click();
	await expect(dialog.locator('input')).toHaveAttribute('placeholder', 'Add context to the chat');
	await dialog.getByRole('option', { name: /Browser Screenshot/ }).click();
}

test('Share with Agent asks first, shows the indicator, replays the log and stops', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, undefined, { 'kingu.browser.agentTools': true });
	const panel = await openBrowserTab(page);
	const status = panel.getByRole('status', { name: 'Agent browser use' });

	// Cancelled: nothing is shared.
	await panel.getByRole('button', { name: 'Share with Agent' }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__e2e.messages.at(-1)?.title)).toBe('Share with Agent?');
	expect(await page.evaluate(() => (window as any).__e2e.messages.at(-1)?.buttons)).toEqual(['Share', 'Cancel']);
	await expect(status).toBeHidden();
	expect(await page.evaluate(() => (window as any).__e2e.calls.agent_browser_share ?? 0)).toBe(0);

	// Share: the tab says agents may use it, with its cookies.
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 0));
	await panel.getByRole('button', { name: 'Share with Agent' }).click();
	await expect(status).toContainText('Shared with agents');
	await expect(panel.getByRole('button', { name: 'Stop Sharing with Agent' })).toHaveAttribute('aria-pressed', 'true');

	// The log: Replay takes the navigation and the click, not the read.
	await status.getByRole('button', { name: 'Log' }).click();
	await expect(page.getByRole('option', { name: /Clicked More information/ })).toBeVisible();
	// Orca's reads are in the log too, under their tool; they only look, so Replay leaves them out.
	await expect(page.getByRole('option', { name: /Waited for #done to be visible/ })).toContainText('wait');
	for (const tool of ['console', 'network', 'cookies']) await expect(page.getByRole('option', { name: new RegExp(`· ${tool}\\b`) })).toBeVisible();
	await page.getByRole('option', { name: /Replay 2 steps on this page/ }).click();
	await expect(page.getByText('Replayed 2 of 2 steps')).toBeVisible();
	expect(await page.evaluate(() => (window as any).__e2e.agentBrowser.replayed.map((s: { tool: string }) => s.tool))).toEqual(['navigate', 'click']);

	// Stop: the page is the user's again.
	await status.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(status).toContainText('Agents were stopped on this page');
	await expect(status.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
	expect(errors).toEqual([]);
});

test('with agent tools off the tab has no Share with Agent', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	const panel = await openBrowserTab(page);
	await expect(panel.getByRole('button', { name: 'Add Screenshot to Chat' })).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Share with Agent' })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('Add Screenshot to Chat and Add Context › Browser Screenshot attach a picture of the tab', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	const chat = page.getByRole('complementary', { name: 'Chat' });
	await expect(chat.getByRole('combobox', { name: /Chat with/ })).toBeVisible();

	// No browser tab yet: Browser Screenshot says so and attaches nothing.
	await addBrowserScreenshot(page);
	await expect(page.getByText('No browser tab is open')).toBeVisible();
	await expect(chat.getByRole('button', { name: /^Remove browser-/ })).toHaveCount(0);

	const panel = await openBrowserTab(page);
	await panel.getByRole('button', { name: 'Add Screenshot to Chat' }).click();
	await expect(chat.getByRole('button', { name: 'Remove browser-1.png' })).toBeAttached();

	// One tab: Add Context takes its picture without asking which.
	await addBrowserScreenshot(page);
	await expect(chat.getByRole('button', { name: 'Remove browser-2.png' })).toBeAttached();
	expect(errors).toEqual([]);
});

test("a Codex or ACP run's browser call asks with VS Code's words, and the answer goes back to the agent host", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, undefined, { 'kingu.browser.agentTools': true }, { browserAsk: true });
	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Check the example page');
	await input.press('Enter');
	const card = chat.getByRole('group', { name: 'Allow mcp__kingu__open_browser_page?' });
	await expect(card).toBeVisible({ timeout: 10_000 });
	await expect(card).toContainText('Open Browser Page?');
	await expect(card).toContainText("This will open https://example.com/ in Kingu's browser. The agent will be able to read and interact with its contents.");
	await card.getByRole('button', { name: /^Run/ }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__e2e.agentAnswers)).toEqual([expect.objectContaining({ requestId: 'br-1', decision: 'allow' })]);
	await expect(card).toHaveCount(0);
	expect(errors).toEqual([]);
});
