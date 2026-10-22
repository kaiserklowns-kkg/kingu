import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { watchErrors } from './mock';

test('switches between the panel tabs', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('banner').getByRole('button', { name: 'Toggle Panel' }).click();

	const panel = page.getByRole('region', { name: 'Panel' });
	await expect(panel).toBeVisible();

	for (const tab of ['Problems', 'Output', 'Debug Console', 'Terminal']) {
		const item = panel.getByRole('tab', { name: tab, exact: true });
		await item.click();
		await expect(item).toHaveAttribute('aria-selected', 'true');
	}
	await expect(panel.getByRole('textbox', { name: 'Debug Console input' })).toBeHidden();
	expect(errors).toEqual([]);
});

test('shows the Problems view and the Debug Console input', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('banner').getByRole('button', { name: 'Toggle Panel' }).click();
	const panel = page.getByRole('region', { name: 'Panel' });

	await panel.getByRole('tab', { name: 'Problems', exact: true }).click();
	await expect(panel.getByRole('textbox', { name: 'Filter Problems' })).toBeVisible();
	await expect(page.getByText('No problems have been detected in the workspace.')).toBeVisible();

	await panel.getByRole('tab', { name: 'Debug Console', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Debug Console input' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('writes typed input to the terminal pty', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('banner').getByRole('button', { name: 'Toggle Panel' }).click();
	const panel = page.getByRole('region', { name: 'Panel' });
	await panel.getByRole('tab', { name: 'Terminal', exact: true }).click();

	const screen = panel.getByRole('textbox', { name: 'Terminal input' });
	await screen.focus();
	await page.keyboard.type('echo e2e');
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await calls(page)).pty_write ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});
