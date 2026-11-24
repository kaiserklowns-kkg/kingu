import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { watchErrors } from './mock';

test('sends a chat message and renders the streamed answer', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await expect(input).toBeVisible();
	await input.fill('Hello agent');
	await input.press('Enter');

	await expect(chat.getByText('Hello agent', { exact: true })).toBeVisible();
	await expect(chat.getByText('Hello from the mock agent')).toBeVisible();
	await expect.poll(async () => (await calls(page)).agent_start ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

// VS Code's ChatViewPane view state: a reloaded window shows the chat it showed; a fresh start does
// only with chat.restoreLastPanelSession on (default off). A new chat starts on the agent last picked.
const CLAUDE = { 'kingu.agent.runtime': 'claude' };
const codexChat = {
	id: 'c-e2e-codex',
	title: 'Port the parser',
	title_auto: false,
	prompt: 'Port the parser',
	cwd: { kind: 'folder' },
	session_id: 'sess-codex',
	model: null,
	permission_mode: null,
	runtime: 'codex',
	created_at: Date.now() - 60_000,
	updated_at: Date.now() - 30_000,
	last_run: null,
	working: false
};

/** Reload the page: `restart` forgets the window's session marker, as an app restart does. */
async function reload(page: import('@playwright/test').Page, restart = false) {
	if (restart) await page.evaluate(() => sessionStorage.removeItem('kingu.window.loaded'));
	await page.reload();
	await expect(page.getByRole('banner')).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press('Escape');
}

test('the chat shown comes back after a reload of the window, not after a restart', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, undefined, CLAUDE, { chats: [codexChat] });
	const chat = page.getByRole('complementary', { name: 'Chat' });
	await expect(chat.getByText('Build with Agent')).toBeVisible();
	await page.getByRole('region', { name: 'Home' }).getByRole('button', { name: /^Port the parser/ }).click();
	await expect(chat.getByRole('button', { name: 'Agent: Codex' })).toBeVisible();

	await reload(page);
	await expect(chat.getByRole('button', { name: 'Agent: Codex' })).toBeVisible();
	await expect(chat.getByText('Build with Agent')).toBeHidden();

	await reload(page, true);
	await expect(chat.getByText('Build with Agent')).toBeVisible();
	await expect(chat.getByRole('button', { name: 'Agent: Claude Code' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('with chat.restoreLastPanelSession on, a restart shows the chat too', async ({ page }) => {
	await openApp(page, undefined, { ...CLAUDE, 'chat.restoreLastPanelSession': true }, { chats: [codexChat] });
	const chat = page.getByRole('complementary', { name: 'Chat' });
	await page.getByRole('region', { name: 'Home' }).getByRole('button', { name: /^Port the parser/ }).click();
	await expect(chat.getByRole('button', { name: 'Agent: Codex' })).toBeVisible();
	await reload(page, true);
	await expect(chat.getByRole('button', { name: 'Agent: Codex' })).toBeVisible();
	await expect(chat.getByText('Build with Agent')).toBeHidden();
});

test('a new chat starts on the agent last picked, after a restart too', async ({ page }) => {
	await openApp(page, undefined, CLAUDE);
	const chat = page.getByRole('complementary', { name: 'Chat' });
	await chat.getByRole('button', { name: 'Agent: Claude Code' }).click();
	await page.getByRole('option', { name: 'Codex' }).click();
	await expect(chat.getByRole('button', { name: 'Agent: Codex' })).toBeVisible();

	await reload(page, true);
	await expect(chat.getByRole('button', { name: 'Agent: Codex' })).toBeVisible();
	await expect(chat.getByRole('combobox', { name: 'Chat with Codex' })).toBeVisible();
	// Picking the default again forgets it.
	await chat.getByRole('button', { name: 'Agent: Codex' }).click();
	await page.getByRole('option', { name: 'Claude Code' }).click();
	await reload(page, true);
	await expect(chat.getByRole('button', { name: 'Agent: Claude Code' })).toBeVisible();
});
