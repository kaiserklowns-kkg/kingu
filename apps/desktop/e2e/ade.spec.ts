import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

test('switches to the Agents layout and opens the task board', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Tasks', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Task Board' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('creates a task from the Now page', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'งานใหม่', exact: true }).click();
	const description = page.getByRole('textbox', { name: /อธิบายงาน/ });
	await description.fill('E2E Task');
	await description.press('Enter');

	await expect.poll(async () => (await calls(page)).worktree_create ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});
