import { expect, type Page } from '@playwright/test';
import { mockTauri, READY } from './mock';
import type { SetupReport } from '../src/lib/setup/setup';

/** Mock Tauri, load the workbench and close the welcome tour if it opened. */
export async function openApp(
	page: Page,
	setup: SetupReport = READY,
	settings: Record<string, unknown> = {},
	opts: { probeFail?: boolean } = {}
) {
	await mockTauri(page, setup, '/tmp/kingu-e2e', settings, opts);
	await page.goto('/');
	await expect(page.getByRole('banner')).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press('Escape');
}

/** Settings through the title bar's Manage menu. */
export async function openSettings(page: Page) {
	await page.getByRole('banner').getByRole('button', { name: 'Manage', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Settings/ }).first().click();
	await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();
}

/** An Activity Bar view (Explorer, Source Control, …). */
export async function openView(page: Page, name: string | RegExp) {
	await page.getByRole('navigation', { name: 'Activity Bar' }).getByRole('button', { name }).click();
}

/** The command palette: Quick Access, `>` for commands, then run the first match. */
export async function runCommand(page: Page, label: string) {
	await page.getByRole('banner').getByRole('button', { name: /Open Quick Access/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Quick open' });
	await expect(dialog).toBeVisible();
	await dialog.locator('input').fill(`>${label}`);
	await dialog.getByRole('option').first().click();
	await expect(dialog).toBeHidden();
}

/** Calls the mocked backend recorded, by command name. */
export async function calls(page: Page): Promise<Record<string, number>> {
	return page.evaluate(() => (window as any).__e2e.calls);
}
