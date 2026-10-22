import { expect, test } from '@playwright/test';
import { openApp } from './helpers';
import { watchErrors } from './mock';

test('switches to the Agents layout and opens the task board', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Tasks', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Task Board' })).toBeVisible();
	expect(errors).toEqual([]);
});
