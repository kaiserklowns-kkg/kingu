import { expect, test } from '@playwright/test';
import { openApp } from './helpers';
import { watchErrors } from './mock';

async function openFile(page: import('@playwright/test').Page, name: 'README.md' | 'package.json' | 'src/main.ts') {
	if (name === 'src/main.ts') await page.getByRole('treeitem', { name: 'src' }).click();
	await page.getByRole('treeitem', { name: name.split('/').pop()! }).dblclick();
}

test('keeps one tab per file and switches between them', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	await openFile(page, 'README.md');
	await openFile(page, 'package.json');
	const tabs = page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab');
	await expect(tabs).toHaveCount(2);

	await page.getByRole('tab', { name: /README\.md/ }).click();
	await expect(page.getByText('A test workspace.')).toBeVisible();
	await expect(page.getByText('"name": "kingu-e2e"')).toBeHidden();

	await page.getByRole('tab', { name: /package\.json/ }).click();
	await expect(page.getByText('"name": "kingu-e2e"')).toBeVisible();
	expect(errors).toEqual([]);
});

test('closes the active editor tab', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openFile(page, 'README.md');
	await expect(page.getByRole('tab', { name: /README\.md/ })).toBeVisible();

	const tab = page.getByRole('tab', { name: /README\.md/ });
	await tab.hover();
	await page.getByRole('button', { name: /^Close README\.md/ }).click();
	await expect(tab).toBeHidden();
	expect(errors).toEqual([]);
});

test('opens a file from Quick Open', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	await page.getByRole('banner').getByRole('button', { name: /Open Quick Access/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Quick open' });
	await dialog.locator('input').fill('App.svelte');
	const option = dialog.getByRole('option', { name: /App\.svelte/ }).first();
	await expect(option).toBeVisible();
	await option.click();

	await expect(dialog).toBeHidden();
	await expect(page.getByRole('tab', { name: /App\.svelte/ })).toBeVisible();
	await expect(page.getByText('Hello {name}')).toBeVisible();
	expect(errors).toEqual([]);
});
