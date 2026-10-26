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
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await description.fill('E2E Task');
	await description.press('Enter');

	await expect.poll(async () => (await calls(page)).worktree_create ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test('the Agents layout opens browser tabs from the tab row', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();

	// "+" shows on a page too (Orca's create menu); a new tab leaves the page for the worktree.
	await page.getByRole('button', { name: 'New Tab', exact: true }).click();
	await page.getByRole('menuitem', { name: /New Browser Tab/ }).click();

	const bar = page.getByRole('textbox', { name: 'Address' });
	await expect(bar).toBeVisible();
	await expect(page.getByRole('tab', { name: /^New Tab/ })).toBeVisible();

	await page.getByRole('button', { name: 'New Tab', exact: true }).click();
	await page.getByRole('menuitem', { name: /New Browser Tab/ }).click();
	await expect(page.getByRole('tab', { name: /^New Tab/ })).toHaveCount(2);
	expect(errors).toEqual([]);
});
