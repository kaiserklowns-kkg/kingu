// Agent and account coverage from Orca 1.4.269–1.4.272: Antigravity's Gemini API key and Google
// Agent Platform (ADC) account types (agent/antigravity_auth.rs, accounts/AntigravityChatAuth.svelte,
// the chat's sign-in card) and a project's GitHub account (agent/gh_account.rs,
// settings/pages/GitHubAccountSetting.svelte). The mock (mock.ts) plays Rust's side. Orca
// `04c88e0df`: the chat offers a key or gcloud login found on the computer (agent/AgyAuthChooser.svelte,
// agent/AgyAuthChip.svelte, Rust `antigravity_chat_auth_detect`).

import { expect, test } from '@playwright/test';
import { calls, openApp, openSettings } from './helpers';
import { READY, watchErrors } from './mock';

test('a Gemini API key chat: the card points at Settings, Try again signs in, no Google page', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { signIn: 'key' });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Hello agent');
	await input.press('Enter');

	const card = chat.locator('[data-sign-in]');
	await expect(card).toHaveAttribute('data-sign-in', 'required');
	await expect(card.getByText(/signs in with a Gemini API key/)).toBeVisible();
	// No Google page of its own: Google sign-in is only the chooser's switch back to a Google account.
	await expect(card.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(1);
	await expect(card.locator('[data-antigravity-auth-chooser]').getByRole('button', { name: 'Sign in with Google' })).toHaveCount(1);
	await expect(card.getByRole('button', { name: 'Open Antigravity settings' })).toBeVisible();
	await card.getByRole('button', { name: 'Try again' }).click();
	await expect.poll(async () => (await calls(page)).agent_sign_in ?? 0).toBe(1);
	await expect(chat.getByText('Signed in and answering').first()).toBeVisible();
	await expect(card).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('Settings › Accounts › Antigravity: pick the account type, save a key to the Keychain, see Agent Platform’s project', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openSettings(page);
	await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: /Accounts/ }).first().click();

	const auth = page.getByTestId('antigravity-chat-auth');
	await expect(auth).toBeVisible();
	await expect(auth.getByRole('radio', { name: /Google account/ })).toHaveAttribute('aria-checked', 'true');

	await auth.getByRole('radio', { name: /Gemini API key/ }).click();
	await expect(auth.getByRole('radio', { name: /Gemini API key/ })).toHaveAttribute('aria-checked', 'true');
	await expect(auth.getByTestId('agy-key-state')).toHaveText("No key saved, and GEMINI_API_KEY isn't set.");
	const key = auth.getByPlaceholder('Paste your API key');
	await expect(key).toHaveAttribute('type', 'password');
	// Google's refusal is shown; nothing is saved.
	await key.fill('not-a-key');
	await auth.getByRole('button', { name: 'Save key' }).click();
	await expect(auth.getByRole('alert')).toContainText('Google rejected this Gemini API key');
	await key.fill('AIza-e2e');
	await auth.getByRole('button', { name: 'Save key' }).click();
	await expect(auth.getByTestId('agy-key-state')).toHaveText('Key saved in the macOS Keychain.');
	await expect(key).toHaveValue('');
	expect(await page.evaluate(() => document.body.innerText.includes('AIza-e2e'))).toBe(false);
	await auth.getByRole('button', { name: 'Remove key' }).click();
	await expect.poll(async () => (await calls(page)).antigravity_api_key_clear ?? 0).toBe(1);

	await auth.getByRole('radio', { name: /Google Agent Platform/ }).click();
	await expect(auth.getByTestId('agy-adc-state')).toContainText('Uses project acme-dev (from gcloud config) in global.');
	await expect(auth.getByRole('button', { name: 'Sign in with gcloud' })).toBeVisible();
	await auth.getByPlaceholder('From gcloud').fill('acme-prod');
	await auth.getByPlaceholder('From gcloud').blur();
	await expect.poll(async () => page.evaluate(() => sessionStorage.getItem(Object.keys(sessionStorage).find((k) => k.includes('settings')) ?? '') ?? '')).toContain('acme-prod');
	expect(errors).toEqual([]);
});

const savedAuth = (page: import('@playwright/test').Page) =>
	page.evaluate(() => JSON.parse(sessionStorage.getItem('__kingu_e2e_settings') ?? '{}')['kingu.agent.antigravityChatAuth'] ?? null);

test("the sign-in card offers what's on the computer: Use gcloud (project) switches, restarts the chat and sends again", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { signIn: 'browser', agyDetect: { apiKey: 'environment', gcloud: 'acme-dev' } });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Hello agent');
	await input.press('Enter');

	const card = chat.locator('[data-sign-in]');
	await expect(card).toHaveAttribute('data-sign-in', 'required');
	const chooser = card.locator('[data-antigravity-auth-chooser]');
	await expect(chooser.getByText('Kingu found credentials on this computer you can use instead:')).toBeVisible();
	const key = chooser.getByRole('button', { name: /Use your Gemini API key/ });
	await expect(key).toContainText('Found GEMINI_API_KEY in your environment');
	const gcloud = chooser.getByRole('button', { name: /Use gcloud \(acme-dev\)/ });
	await expect(gcloud).toContainText('Found your gcloud login (Application Default Credentials)');
	// Google's own button stays the card's; Settings is one link away.
	await expect(card.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(1);
	await expect(chooser.getByRole('button', { name: 'More options…' })).toBeVisible();

	await gcloud.click();
	await expect(chat.getByText('Hello from the mock agent').first()).toBeVisible();
	await expect(card).toHaveCount(0);
	expect(await savedAuth(page)).toEqual({ method: 'agent-platform' });
	const c = await calls(page);
	expect([c.antigravity_chat_stop_live, c.agent_start, c.antigravity_api_key_save, c.message_box]).toEqual([1, 2, undefined, undefined]);
	await expect(page.getByText('Antigravity now uses Google Agent Platform.')).toBeVisible();
	expect(errors).toEqual([]);
});

test('the chip under an Antigravity chat: the method in use, Detected ones one click away, a confirm before running chats restart', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.runtime': 'antigravity' }, { agyDetect: { apiKey: 'environment', gcloud: 'acme-dev' } });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const chip = chat.getByRole('button', { name: 'Antigravity signs in with Google account. Change' });
	await expect(chip).toBeVisible();
	await chip.click();
	const menu = chat.getByRole('listbox', { name: 'Antigravity signs in with' });
	await expect(menu.getByRole('option', { name: /Google account/ })).toHaveAttribute('aria-selected', 'true');
	await expect(menu.getByRole('option', { name: /Gemini API key/ })).toContainText('Detected');
	await expect(menu.getByRole('option', { name: /Google Agent Platform/ })).toContainText('Detected');
	await expect(menu.getByRole('option', { name: 'Sign-in settings…' })).toBeVisible();

	// No chat runs: the environment's key is used at once, and never copied to the Keychain.
	await menu.getByRole('option', { name: /Gemini API key/ }).click();
	await expect(chat.getByRole('button', { name: 'Antigravity signs in with Gemini API key. Change' })).toBeVisible();
	expect(await savedAuth(page)).toEqual({ method: 'gemini-api-key' });
	expect((await calls(page)).antigravity_api_key_save).toBeUndefined();

	// A chat is running: asked first; Cancel keeps the key.
	await page.evaluate(() => {
		(window as any).__e2e.agyAuth.live = 1;
		(window as any).__e2e.messageAnswer = 1;
	});
	await chat.getByRole('button', { name: /Antigravity signs in with Gemini API key/ }).click();
	await menu.getByRole('option', { name: /Google Agent Platform/ }).click();
	await expect.poll(async () => (await calls(page)).message_box ?? 0).toBe(1);
	const asked = await page.evaluate(() => (window as any).__e2e.messages.at(-1));
	expect([asked.title, asked.message, asked.buttons[0]]).toEqual(['Switch to Google Agent Platform?', 'Antigravity chats running on this computer restart. A reply in progress stops; your conversations stay.', 'Switch']);
	expect(await savedAuth(page)).toEqual({ method: 'gemini-api-key' });

	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 0));
	await chat.getByRole('button', { name: /Antigravity signs in with Gemini API key/ }).click();
	await menu.getByRole('option', { name: /Google Agent Platform/ }).click();
	await expect(chat.getByRole('button', { name: 'Antigravity signs in with Google Agent Platform · acme-dev. Change' })).toBeVisible();
	expect(await savedAuth(page)).toEqual({ method: 'agent-platform' });
	expect((await calls(page)).antigravity_chat_stop_live).toBeGreaterThanOrEqual(2);
	expect(errors).toEqual([]);
});

test("the project pane's GitHub account: pick a keyring login, or the one that owns origin", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openSettings(page);
	await page.getByRole('navigation', { name: 'Settings' }).getByTitle('/tmp/kingu-e2e').click();

	const section = page.getByTestId('github-account-setting');
	await expect(section).toBeVisible();
	const select = section.getByRole('combobox', { name: 'Account' });
	await expect(select).toHaveValue('__ambient_gh_login__');
	// An env-token login is listed but can't be chosen.
	await expect(select.locator('option', { hasText: 'ci-bot @ github.com (GH_TOKEN)' })).toBeDisabled();
	await expect(section.getByTestId('gh-account-suggestion')).toContainText("alice-work @ github.com owns this project's origin.");

	await select.selectOption({ label: 'alice @ github.com' });
	await expect.poll(async () => (await calls(page)).gh_account_validate ?? 0).toBe(1);
	await expect(select).toHaveValue('github.com\u0000alice');

	await section.getByRole('button', { name: 'Use it' }).click();
	await expect(select).toHaveValue('github.com\u0000alice-work');
	await expect(section.getByTestId('gh-account-suggestion')).toHaveCount(0);

	await select.selectOption({ label: 'Default (ambient gh login)' });
	await expect(select).toHaveValue('__ambient_gh_login__');
	expect(errors).toEqual([]);
});
