import { expect, test, type Page } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

/** Rust's `ssh-agent-install:changed`: Codex's status on `box` with this operation (and these fields). */
async function progress(page: Page, operation: object | null, fields: object = {}) {
	await page.evaluate(
		([operation, fields]) => {
			const e2e = (window as any).__e2e;
			const s = e2e.sshAgentList.find((x: { agent: string }) => x.agent === 'codex');
			Object.assign(s, fields, { operation });
			e2e.emit('ssh-agent-install:changed', { ...s });
		},
		[operation, fields] as const
	);
}

const MB = 1_000_000;

/** SSH Hosts, from the Agents side bar's Add project menu. */
async function openHosts(page: Page) {
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'Add project', exact: true }).click();
	await page.getByRole('menuitem', { name: 'SSH Hosts…' }).click();
}

test('SSH Hosts › Agents installs an agent CLI on the host: asked by a click, progress, installed, removed', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { ssh: true });
	await openHosts(page);
	const dialog = page.getByRole('dialog', { name: 'SSH Hosts' });
	await dialog.getByRole('button', { name: 'Agents', exact: true }).click();

	const panel = dialog.getByRole('region', { name: 'Agent CLIs on box' });
	await expect(panel.getByText('Host: linux-x64')).toBeVisible();
	// The user's own copy is said, with nothing to install; Codex's size and source show before any download.
	await expect(panel.locator('[data-ssh-agent="claude"]').getByRole('status')).toHaveText('Uses the copy found on this host.');
	const row = panel.locator('[data-ssh-agent="codex"]');
	await expect(row.getByRole('status')).toHaveText('Not installed. 54 MB download from github.com.');
	// Looking is not installing.
	expect((await calls(page)).ssh_agent_install ?? 0).toBe(0);

	await row.getByRole('button', { name: 'Install', exact: true }).click();
	await expect.poll(async () => (await calls(page)).ssh_agent_install ?? 0).toBe(1);
	await expect(row.getByRole('status')).toHaveText('Downloading on the host: 0.0 MB of 54.0 MB.');

	await progress(page, { id: 1, kind: 'install', phase: 'downloading', downloadedBytes: 27 * MB, totalBytes: 54 * MB });
	await expect(row.getByRole('progressbar', { name: 'Codex download on box' })).toHaveAttribute('aria-valuenow', '50');
	await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

	await progress(page, { id: 1, kind: 'install', phase: 'verifying', downloadedBytes: 54 * MB, totalBytes: 54 * MB });
	await expect(row.getByRole('status')).toHaveText('Checking that Codex starts.');

	await progress(page, { id: 1, kind: 'install', phase: 'succeeded', downloadedBytes: 54 * MB, totalBytes: 54 * MB }, { installedVersion: '0.50.0', installedCurrent: true, canRemove: true, source: 'managed' });
	await expect(row.getByRole('status')).toHaveText('Installed by Kingu · 0.50.0');
	await expect(row.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);

	// Remove asks first, then takes Kingu's copy off the host.
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 0));
	await row.getByRole('button', { name: 'Remove', exact: true }).click();
	await expect.poll(async () => (await calls(page)).ssh_agent_remove ?? 0).toBe(1);
	await expect(row.getByRole('status')).toHaveText('Not installed. 54 MB download from github.com.');
	expect(errors).toEqual([]);
});

test('a failed install on the host says why and offers to try again', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { ssh: true });
	await openHosts(page);
	const dialog = page.getByRole('dialog', { name: 'SSH Hosts' });
	await dialog.getByRole('button', { name: 'Agents', exact: true }).click();
	const row = dialog.locator('[data-ssh-agent="codex"]');
	await row.getByRole('button', { name: 'Install', exact: true }).click();
	await expect.poll(async () => (await calls(page)).ssh_agent_install ?? 0).toBe(1);

	await progress(page, { id: 1, kind: 'install', phase: 'failed', downloadedBytes: 54 * MB, totalBytes: 54 * MB, error: "the download doesn't match the publisher's checksum" });
	await expect(row.getByRole('alert')).toHaveText("Couldn’t install Codex: the download doesn't match the publisher's checksum");
	await expect(row.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});
