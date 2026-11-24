import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

test("a task's hibernated agent pane keeps its tab with a sleep mark and resumes when opened", async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude', 'kingu.terminal.quickCommands': { Dev: 'bun run dev' } });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await description.fill('Nap time');
	await description.press('Enter');
	await expect.poll(async () => (await calls(page)).worktree_create ?? 0).toBeGreaterThan(0);

	// Two terminal tabs in the task's worktree; the second stays in front.
	for (let i = 0; i < 2; i++) await page.getByRole('button', { name: /^Run Dev in a new terminal/ }).click();
	const keys = async () => page.evaluate(() => (window as any).__e2e.spawns.map((s: { key: string }) => s.key).filter((k: string) => /^ade:[0-9a-f]{8}:[^:]+:t\d+$/.test(k)));
	await expect.poll(async () => (await keys()).length).toBeGreaterThanOrEqual(2);
	const [first] = await keys();

	// The coordinator closed the first tab's claude (its record, as paneSleep keeps it), then Kingu restarted.
	const [, tag] = first.split(':');
	await page.evaluate(
		({ tag, first }) => localStorage.setItem(`kingu.adeSleepingPanes:${tag}`, JSON.stringify({ v: 1, panes: { [first]: { agent: 'claude', sessionId: '0f7c8a52-6a1e-4c55-9d0b-2b8f0c7a1e11', at: Date.now() - 60_000 } } })),
		{ tag, first }
	);
	await page.reload();
	await expect(page.getByRole('banner')).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press('Escape');

	const mark = page.getByRole('status', { name: /^Agent hibernated .*: it continues its session when you open this tab$/ });
	await expect(mark).toHaveCount(1);
	// Opening the tab starts claude again on its session in that pane (typed into its shell, or as the new shell's command).
	await page.getByRole('tab').filter({ has: mark }).click();
	await expect(mark).toHaveCount(0);
	await expect
		.poll(async () =>
			page.evaluate((k) => {
				const e2e = (window as any).__e2e;
				const typed: string[] = e2e.writes.filter((w: { key: string }) => w.key === k).map((w: { data: string }) => w.data);
				const runs: string[] = e2e.spawns.filter((s: { key: string; run: string[] | null }) => s.key === k && s.run).map((s: { run: string[] }) => s.run.join(' '));
				return [...typed, ...runs].some((line) => /\bclaude\b.*--resume 0f7c8a52-6a1e-4c55-9d0b-2b8f0c7a1e11/.test(line));
			}, first)
		)
		.toBe(true);
	expect(errors).toEqual([]);
});
