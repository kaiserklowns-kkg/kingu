import { expect, test } from '@playwright/test';
import { calls, openApp, openSettings } from './helpers';
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

test('saves a setting and keeps it after reload', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openSettings(page);
	await page.getByRole('button', { name: 'Terminal', exact: true }).click();

	const shell = page.getByRole('textbox', { name: 'Shell', exact: true });
	await shell.fill('/bin/bash');
	await shell.blur();
	await expect.poll(async () => (await calls(page)).settings_write ?? 0).toBeGreaterThan(0);

	await page.reload();
	await expect(page.getByRole('banner')).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press('Escape');
	await openSettings(page);
	await page.getByRole('button', { name: 'Terminal', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Shell', exact: true })).toHaveValue('/bin/bash');
	expect(errors).toEqual([]);
});
