import { expect, test, type Page } from '@playwright/test';
import { openApp, openView } from './helpers';
import { watchErrors } from './mock';

const VIEWS: { button: RegExp; label: string; marker: (page: Page) => ReturnType<Page['locator']> }[] = [
	{ button: /^Search/, label: 'Search', marker: (page) => page.getByRole('region', { name: 'Search', exact: true }) },
	{
		button: /^Source Control/,
		label: 'Source Control',
		marker: (page) => page.getByRole('textbox', { name: 'Source Control commit message' })
	},
	{ button: /^Run and Debug/, label: 'Run and Debug', marker: (page) => page.getByRole('button', { name: 'Open launch.json' }) },
	{ button: /^Testing/, label: 'Testing', marker: (page) => page.getByRole('textbox', { name: 'Filter tests' }) },
	{ button: /^Snaps/, label: 'Snaps', marker: (page) => page.getByRole('searchbox', { name: 'Search Snaps' }) },
	{ button: /^Agents/, label: 'Agents', marker: (page) => page.getByRole('button', { name: 'เปิดบอร์ด' }) },
	{ button: /^AI Vault/, label: 'AI Vault', marker: (page) => page.getByRole('searchbox', { name: 'Search sessions' }) },
	{ button: /^Artifacts/, label: 'Artifacts', marker: (page) => page.getByRole('searchbox', { name: 'Filter artifacts' }) },
	{ button: /^Explorer/, label: 'Explorer', marker: (page) => page.getByRole('tree', { name: /ไฟล์ใน workspace/ }) }
];

test('every Activity Bar view opens', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	for (const view of VIEWS) {
		await openView(page, view.button);
		await expect(page.getByRole('navigation', { name: 'Activity Bar' }).getByRole('button', { name: view.button })).toHaveAttribute('aria-pressed', 'true');
		await expect(view.marker(page)).toBeVisible();
	}
	expect(errors).toEqual([]);
});

test('Source Control lists the changed files from git status', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openView(page, /^Source Control/);

	await expect(page.getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /^main\.ts/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /Switch Branch: main/ })).toBeVisible();
	expect(errors).toEqual([]);
});

test('Search view has its query input and replace toggle', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openView(page, /^Search/);

	const search = page.getByRole('region', { name: 'Search', exact: true });
	await expect(search.getByRole('textbox', { name: 'Search' })).toBeVisible();
	await expect(search.getByRole('button', { name: 'Toggle Replace' })).toBeVisible();
	expect(errors).toEqual([]);
});
