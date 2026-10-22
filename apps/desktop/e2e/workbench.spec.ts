import { expect, test } from '@playwright/test';
import { calls, openApp, openSettings, runCommand } from './helpers';
import { watchErrors } from './mock';

test('opens a workspace file from the Explorer and reads it', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	const tree = page.getByRole('treeitem', { name: 'README.md' });
	await expect(tree).toBeVisible();
	await tree.click();

	await expect(page.getByRole('tab', { name: /README\.md/ })).toBeVisible();
	await expect(page.getByText('A test workspace.')).toBeVisible();
	expect((await calls(page)).textfile_read).toBeGreaterThan(0);

	await page.getByRole('treeitem', { name: 'src' }).click();
	await expect(page.getByRole('treeitem', { name: 'main.ts' })).toBeVisible();
	await page.getByRole('treeitem', { name: 'main.ts' }).click();
	await expect(page.getByRole('tab', { name: /main\.ts/ })).toBeVisible();
	await expect(page.getByText('export const answer = 42;')).toBeVisible();
	expect((await calls(page)).textfile_read).toBeGreaterThan(1);
	expect(errors).toEqual([]);
});

test('opens the panel with a terminal', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	await page.getByRole('banner').getByRole('button', { name: 'Toggle Panel' }).click();
	const panel = page.getByRole('region', { name: 'Panel' });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('tab', { name: 'Terminal' })).toBeVisible();
	await expect(panel.getByText('zsh')).toBeVisible();
	await expect.poll(async () => (await calls(page)).pty_spawn ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test('runs a command from the command palette', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	await runCommand(page, 'Setup: Check This Machine');
	await expect(page.getByRole('heading', { name: 'Setup check' })).toBeVisible();
	await expect(page.getByText('Ready to use')).toBeVisible();
	expect(errors).toEqual([]);
});

test('opens Settings from the Manage menu and goes back to the app', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await openSettings(page);
	await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();
	await page.getByRole('button', { name: 'Back to app' }).click();
	await expect(page.getByRole('navigation', { name: 'Settings' })).toBeHidden();
	expect(errors).toEqual([]);
});
