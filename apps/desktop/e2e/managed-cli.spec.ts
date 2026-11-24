import { expect, test, type Page } from '@playwright/test';
import { calls, openApp, openSettings } from './helpers';
import { READY, watchErrors } from './mock';

/** Rust's `managed-cli:changed`: Copilot's status with this operation (and these fields). */
async function progress(page: Page, operation: object | null, fields: object = {}) {
	await page.evaluate(
		([operation, fields]) => {
			const e2e = (window as any).__e2e;
			const s = e2e.managed.find((x: { agent: string }) => x.agent === 'copilot');
			Object.assign(s, fields, { operation });
			e2e.emit('managed-cli:changed', { ...s });
		},
		[operation, fields] as const
	);
}

const MB = 1_000_000;

test('Settings › Agents installs an agent CLI Kingu manages: Install, progress, installed', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { managed: true });
	await openSettings(page);
	await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Agents', exact: true }).click();

	const row = page.locator('[data-managed-cli="copilot"]');
	// The latest release was looked up: its size is said before anything is downloaded.
	await expect(row.getByRole('status')).toHaveText('Not installed. 54 MB download.');
	await row.getByRole('button', { name: 'Install', exact: true }).click();
	await expect.poll(async () => (await calls(page)).managed_cli_install ?? 0).toBe(1);
	await expect(row.getByRole('status')).toHaveText('Downloading 0.0 MB of 54.0 MB.');

	await progress(page, { id: 1, kind: 'install', phase: 'downloading', downloadedBytes: 27 * MB, totalBytes: 54 * MB });
	await expect(row.getByRole('progressbar', { name: 'Copilot download' })).toHaveAttribute('aria-valuenow', '50');
	await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

	await progress(page, { id: 1, kind: 'install', phase: 'extracting', downloadedBytes: 54 * MB, totalBytes: 54 * MB });
	// Shown "Unpacking…" with a spinner, spoken with the agent's name (Orca 4f56f7c0e).
	await expect(row.getByRole('status')).toContainText('Unpacking…');
	await expect(row.getByRole('status').locator('.sr-only')).toHaveText('Unpacking Copilot…');

	await progress(page, { id: 1, kind: 'install', phase: 'succeeded', downloadedBytes: 54 * MB, totalBytes: 54 * MB }, { installedVersion: '1.0.5', installedCurrent: true, canRemove: true, source: 'managed' });
	await expect(row.getByRole('status')).toHaveText('Installed by Kingu · 1.0.5');
	await expect(row.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
	await expect(row.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("the chat offers to install an agent it lacks and shows the download's steps", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { managed: true });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	await chat.getByRole('button', { name: /^Agent: / }).click();
	await page.getByRole('option', { name: 'Install Copilot…' }).click();

	await expect(chat.getByRole('heading', { name: 'Install Copilot to start chatting' })).toBeVisible();
	// What is downloaded and from where, before anything is.
	await expect(chat.getByText(/One-time 54 MB download\..*It comes from github\.com/)).toBeVisible();
	await chat.getByRole('button', { name: 'Install Copilot' }).click();
	await expect.poll(async () => (await calls(page)).managed_cli_install ?? 0).toBe(1);

	await progress(page, { id: 1, kind: 'install', phase: 'downloading', downloadedBytes: 27 * MB, totalBytes: 54 * MB });
	await expect(chat.getByRole('heading', { name: 'Downloading Copilot' })).toBeVisible();
	await expect(chat.getByRole('progressbar', { name: 'Copilot download' })).toHaveAttribute('aria-valuenow', '50');
	await expect(chat.getByText('27.0 of 54.0 MB')).toBeVisible();
	await expect(chat.locator('li[aria-current="step"]')).toHaveText('Download');

	await progress(page, { id: 1, kind: 'install', phase: 'verifying', downloadedBytes: 54 * MB, totalBytes: 54 * MB });
	await expect(chat.getByRole('heading', { name: 'Checking the download' })).toBeVisible();
	await expect(chat.locator('li[aria-current="step"]')).toHaveText('Check');

	// A failure says why and offers to try again.
	await progress(page, { id: 1, kind: 'install', phase: 'failed', downloadedBytes: 54 * MB, totalBytes: 54 * MB, error: 'Checksum mismatch' });
	await expect(chat.getByRole('heading', { name: "Couldn't install Copilot" })).toBeVisible();
	await expect(chat.getByText('Checksum mismatch')).toBeVisible();
	await expect(chat.getByRole('button', { name: 'Try again' })).toBeVisible();
	expect(errors).toEqual([]);
});
