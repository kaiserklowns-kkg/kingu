import { expect, test } from '@playwright/test';
import { openApp, openView } from './helpers';
import { watchErrors } from './mock';

test('AI Vault lists sessions from the backend', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openView(page, /^AI Vault/);

	const vault = page.getByRole('searchbox', { name: 'Search sessions' });
	await expect(vault).toBeVisible();
	await expect(page.getByRole('listitem').filter({ hasText: 'E2E Vault Session' })).toBeVisible();
	await expect(page.getByText('A past session from the fixture')).toBeVisible();
	expect(errors).toEqual([]);
});

test('Artifacts lists published pages from the backend', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openView(page, /^Artifacts/);

	await expect(page.getByRole('searchbox', { name: 'Filter artifacts' })).toBeVisible();
	await expect(page.getByRole('listitem').filter({ hasText: 'E2E Artifact' })).toBeVisible();
	await expect(page.getByText(/v1/)).toBeVisible();
	expect(errors).toEqual([]);
});

test('Snaps lists the built-in section and its filter', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openView(page, /^Snaps/);

	await expect(page.getByRole('searchbox', { name: 'Search Snaps' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Built-in' })).toBeVisible();
	expect(errors).toEqual([]);
});
