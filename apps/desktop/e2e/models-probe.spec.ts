import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

test('a new chat asks the agent once for models and lists them in the picker', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	const chat = page.getByRole('complementary', { name: 'Chat' });
	// Switch the session target to OpenCode (an ACP agent).
	const target = chat.getByRole('button', { name: 'Agent: Claude Code' });
	await expect(target).toBeVisible();
	await target.click();
	await page.getByRole('option', { name: 'OpenCode' }).click();

	// The model chip opens the picker: the one-off probe answers, the rows fill in.
	const model = chat.getByRole('button', { name: /Model: / });
	await model.click();
	const menu = page.getByRole('listbox', { name: 'Model' });
	await expect(menu.getByRole('option', { name: 'Big Pickle' })).toBeVisible({ timeout: 5_000 });
	await expect(menu.getByRole('option', { name: 'Beam Free' })).toBeVisible();

	// Once per app: reopening the picker does not ask again.
	await page.keyboard.press('Escape');
	await model.click();
	await expect(menu.getByRole('option', { name: 'Big Pickle' })).toBeVisible();
	await expect.poll(async () => (await calls(page)).agent_list_models).toBe(1);
	expect(errors).toEqual([]);
});

test('New Chat keeps the last agent and drops the Claude default model', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.model': 'claude-opus-5-5' });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const target = chat.getByRole('button', { name: 'Agent: Claude Code' });
	await target.click();
	await page.getByRole('option', { name: 'OpenCode' }).click();

	// Another New Chat (the header's dropdown, plain entry): the last agent stays; the default
	// model is Claude's, so the model chip falls back to "Default", never a Claude model.
	await chat.getByRole('button', { name: 'New Chat', exact: true }).click();
	// The item's accessible name carries its key label ("New Chat ⌘N").
	await page.getByRole('menuitem', { name: /^New Chat( ⌘N)?$/ }).click();
	await expect(chat.getByRole('button', { name: 'Agent: OpenCode' })).toBeVisible();
	await expect(chat.getByRole('button', { name: /Model: / })).toHaveAccessibleName(/Model: Default/);
	// The picker lists OpenCode's own models.
	await chat.getByRole('button', { name: /Model: / }).click();
	await expect(page.getByRole('option', { name: 'Big Pickle' })).toBeVisible({ timeout: 5_000 });
	expect(errors).toEqual([]);
});
