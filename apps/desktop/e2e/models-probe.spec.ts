import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

// These specs drive Claude Code; pin the runtime since the default is now Arkai.
const CLAUDE = { 'kingu.agent.runtime': 'claude' };

test('a new chat asks the agent once for models and lists them in the picker', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, CLAUDE);

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
	await openApp(page, READY, { ...CLAUDE, 'kingu.agent.model': 'claude-opus-5-5' });

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

test('a failed model ask says so and the picker offers a retry', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, CLAUDE, { probeFail: true });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const target = chat.getByRole('button', { name: 'Agent: Claude Code' });
	await target.click();
	await page.getByRole('option', { name: 'OpenCode' }).click();
	const model = chat.getByRole('button', { name: /Model: / });
	await model.click();
	// The ask ran and failed: the picker names it, the chip stays "Default".
	await expect(page.getByText('Could not list models')).toBeVisible();
	await expect(chat.getByRole('button', { name: /Model: / })).toHaveAccessibleName(/Model: Default/);
	// The next open retries (the mock answers fine now); the rows fill.
	await page.keyboard.press('Escape');
	await model.click();
	await expect(page.getByRole('option', { name: 'Big Pickle' })).toBeVisible({ timeout: 5_000 });
	expect(errors).toEqual([]);
});

test('a picked model stays the default of that runtime\'s next new chat', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, CLAUDE);

	const chat = page.getByRole('complementary', { name: 'Chat' });
	// Move to OpenCode and pick a real model for the about-to-open chat.
	const target = chat.getByRole('button', { name: 'Agent: Claude Code' });
	await target.click();
	await page.getByRole('option', { name: 'OpenCode' }).click();
	const model = chat.getByRole('button', { name: /Model: / });
	await model.click();
	await page.getByRole('option', { name: 'Big Pickle' }).click();
	await expect(model).toHaveAccessibleName(/Model: .*Big Pickle/);

	// A later New Chat with the same runtime starts with that model, not "Default".
	await chat.getByRole('button', { name: 'New Chat', exact: true }).click();
	await page.getByRole('menuitem', { name: /^New Chat( ⌘N)?$/ }).click();
	await expect(chat.getByRole('button', { name: 'Agent: OpenCode' })).toBeVisible();
	await expect(chat.getByRole('button', { name: /Model: / })).toHaveAccessibleName(/Model: .*Big Pickle/);
	// Claude keeps its own default (never borrows another runtime's memory).
	await chat.getByRole('button', { name: 'Agent: OpenCode' }).click();
	await page.getByRole('option', { name: 'Claude Code' }).click();
	await expect(chat.getByRole('button', { name: /Model: / })).not.toHaveAccessibleName(/Pickle/i);
	expect(errors).toEqual([]);
});
