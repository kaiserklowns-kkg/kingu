import { expect, test } from '@playwright/test';
import { openApp, openSettings } from './helpers';
import { watchErrors } from './mock';

test('navigates between Settings pages', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openSettings(page);

	await page.getByRole('button', { name: 'Terminal', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Setup check', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Setup check', exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test('filters the Settings navigation', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openSettings(page);

	const nav = page.getByRole('navigation', { name: 'Settings' });
	await nav.getByRole('textbox').fill('terminal');
	await expect(nav.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
	await expect(nav.getByRole('button', { name: 'Setup check', exact: true })).toBeHidden();
	expect(errors).toEqual([]);
});
