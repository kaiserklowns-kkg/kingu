// The chat's sign-in card (agent/AgentSignInCard.svelte): a signed-out agent's run waits for the
// user's Sign in instead of failing (agent-host acpSignIn.ts). Kingu's Antigravity server runs
// Google's sign-in itself and the card shows the page to open; `agy` signs in with its own login
// in a Kingu terminal, as Cursor does with `cursor-agent login`. The mock (mock.ts `signIn`) plays the agent's side.

import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, SIGN_IN_URL, watchErrors } from './mock';

test("Kingu's Antigravity server: Sign in with Google shows the agent's own sign-in page, then the chat goes on", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { signIn: 'browser' });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Hello agent');
	await input.press('Enter');

	const card = chat.locator('[data-sign-in]');
	await expect(card).toHaveAttribute('data-sign-in', 'required');
	await expect(card.getByText('Sign in to Antigravity')).toBeVisible();
	await expect(card.getByText(/Kingu never sees your password or token/)).toBeVisible();
	await card.getByRole('button', { name: 'Sign in with Google' }).click();
	await expect.poll(async () => (await calls(page)).agent_sign_in ?? 0).toBe(1);

	// The link the agent reported: opened on the user's click, or copied.
	await expect(card).toHaveAttribute('data-sign-in', 'waiting');
	await expect(card.getByRole('status')).toHaveText('Finish signing in to Google in your browser.');
	await expect(card.getByRole('button', { name: 'Open sign-in page' })).toBeVisible();
	await expect(card.getByRole('button', { name: 'Copy link' })).toBeVisible();
	expect(await page.evaluate(() => document.body.innerText.includes('accounts.google.com'))).toBe(false);

	await page.evaluate(() => (window as any).__e2e.signInDone());
	await expect(chat.getByText('Signed in and answering').first()).toBeVisible();
	await expect(card).toHaveCount(0);
	expect(errors).toEqual([]);
	expect(SIGN_IN_URL).toContain('127.0.0.1');
});

test("agy: the card runs agy's own login in a terminal, then I've signed in continues the chat", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { signIn: 'terminal' });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Hello agent');
	await input.press('Enter');

	const card = chat.locator('[data-sign-in]');
	await expect(card).toHaveAttribute('data-via', 'terminal');
	await card.getByRole('button', { name: 'Sign in in a terminal' }).click();
	// A new terminal opens in the panel to run agy's own login (terminals.open `run`).
	await expect(page.getByRole('button', { name: 'Sign in to Antigravity' }).getByTitle('env AGY_CLI_DISABLE_AUTO_UPDATE=true agy')).toBeVisible();

	await card.getByRole('button', { name: "I've signed in" }).click();
	await expect.poll(async () => (await calls(page)).agent_sign_in ?? 0).toBe(1);
	await expect(chat.getByText('Signed in and answering').first()).toBeVisible();
	await expect(card).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("Cursor: the card runs `cursor-agent login` in a terminal, then I've signed in continues the chat", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { signIn: 'cursor' });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Hello agent');
	await input.press('Enter');

	const card = chat.locator('[data-sign-in]');
	await expect(card).toHaveAttribute('data-via', 'terminal');
	await expect(card.getByText('Sign in to Cursor')).toBeVisible();
	await card.getByRole('button', { name: 'Sign in in a terminal' }).click();
	await expect(page.getByRole('button', { name: 'Sign in to Cursor' }).getByTitle('cursor-agent login')).toBeVisible();

	await card.getByRole('button', { name: "I've signed in" }).click();
	await expect.poll(async () => (await calls(page)).agent_sign_in ?? 0).toBe(1);
	await expect(chat.getByText('Signed in and answering').first()).toBeVisible();
	await expect(card).toHaveCount(0);
	expect(errors).toEqual([]);
});
