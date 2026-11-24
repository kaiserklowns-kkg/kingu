import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

test("an SSH project's header follows its host's connection: connecting, connected, a drop and the reconnect", async ({ page }) => {
	const errors = watchErrors(page);
	// The first dial waits until the test lets it answer.
	await openApp(page, READY, {}, { ssh: { connect: 'hold' } });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByText('On SSH hosts', { exact: true })).toBeVisible();

	const dot = (status: string) => page.getByRole('img', { name: `box: ${status}`, exact: true });
	await expect(dot('Connecting…')).toBeVisible();
	await expect(page.getByText('Connecting…', { exact: true })).toBeVisible();

	await page.evaluate(() => (window as any).__e2e.sshRelease());
	await expect(dot('Connected')).toBeVisible();
	// Connected says nothing beside the dot; the worktrees are read on the host.
	await expect(page.getByText('Connecting…', { exact: true })).toHaveCount(0);
	await expect.poll(async () => (await calls(page)).ssh_project_worktrees ?? 0).toBeGreaterThan(0);

	// The host stops answering: a failed read is checked with the keepalive probe, which fails too,
	// and the redials are refused until the host is back.
	await page.evaluate(() => {
		const ssh = (window as any).__e2e.ssh;
		ssh.worktrees = 'Connection reset by peer';
		ssh.keepalive = 'Connection reset by peer';
		ssh.connect = 'ssh: connect to host box.example.test port 22: Connection refused';
	});
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(dot('Reconnecting…')).toBeVisible();
	await expect(page.getByText('Lost the connection to box. Reconnecting…')).toBeVisible();

	// Back: the ladder's next dial connects.
	await page.evaluate(() => {
		const ssh = (window as any).__e2e.ssh;
		ssh.worktrees = 'ok';
		ssh.keepalive = 'ok';
		ssh.connect = 'ok';
	});
	await expect(dot('Connected')).toBeVisible({ timeout: 15_000 });
	expect(errors).toEqual([]);
});
