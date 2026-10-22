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
