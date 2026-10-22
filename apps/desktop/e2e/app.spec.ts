import { expect, test } from '@playwright/test';
import { BLOCKED, mockTauri, READY, watchErrors } from './mock';

test('boots into the workspace and opens Settings › Setup check', async ({ page }) => {
	const errors = watchErrors(page);
	await mockTauri(page, READY);
	await page.goto('/');
	await expect(page.getByRole('banner')).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press('Escape');

	await page.getByRole('banner').getByRole('button', { name: 'Manage', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Settings/ }).first().click();
	await page.getByRole('button', { name: 'Setup check' }).click();

	await expect(page.getByRole('heading', { name: 'Setup check' })).toBeVisible();
	await expect(page.getByText('Ready to use')).toBeVisible();
	await expect(page.getByText('git version 2.43.0')).toBeVisible();
	await expect(page.getByText('claude, codex')).toBeVisible();
	await expect(page.getByText('/bin/zsh')).toBeVisible();
	expect(errors).toEqual([]);
});

test('a missing agent and gh show the fixes on the setup page', async ({ page }) => {
	await mockTauri(page, BLOCKED);
	await page.goto('/');
	await expect(page.getByRole('banner')).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press('Escape');

	await page.getByRole('banner').getByRole('button', { name: 'Manage', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Settings/ }).first().click();
	await page.getByRole('button', { name: 'Setup check' }).click();

	await expect(page.getByText(/Cannot start yet/)).toBeVisible();
	await expect(page.getByText('Coding agent CLI', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Set up agents' })).toBeVisible();
	await expect(page.getByText('GitHub CLI (gh)', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
});
