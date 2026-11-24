import { expect, test, type Page } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

/** A task whose claude reports through Kingu's hooks (its PermissionRequest hook can wait for the card). */
async function startTask(page: Page) {
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await description.fill('Clean the build folder');
	await description.press('Enter');
	await expect.poll(async () => (await calls(page)).agent_hook_settings ?? 0).toBeGreaterThan(0);
}

const answers = (page: Page) => page.evaluate(() => (window as any).__e2e.permissionAnswers);
const typed = (page: Page) => page.evaluate(() => (window as any).__e2e.writes.map((w: { data: string }) => w.data));

test('a held permission prompt shows the request and allows it for this session', async ({ page }) => {
	const errors = watchErrors(page);
	await startTask(page);

	// claude waits in its hook (`kingu_hold`) and suggests an allow rule for the session.
	await page.evaluate(() =>
		(window as any).__e2e.hookEvents.push({
			hook_event_name: 'PermissionRequest',
			tool_name: 'Bash',
			session_id: 's1',
			kingu_hold: 'hold-1',
			tool_input: { command: 'rm -rf build' },
			permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }] }]
		})
	);
	const card = page.getByRole('alertdialog', { name: 'Permission needed' }).first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	// The request itself (the command) and exactly what a session allow would grant.
	await expect(card.locator('pre')).toHaveText('rm -rf build');
	await expect(card.locator('div', { hasText: /^Allowing for this session also grants/ }).getByRole('listitem')).toHaveText(['Run without asking: Bash(rm -rf build)']);
	await expect(card.getByText(/Your answer goes to claude as its own allow \/ deny decision/)).toBeVisible();

	await card.getByRole('button', { name: 'Allow for this session' }).click();
	await expect(card).toHaveCount(0);
	// The answer went to the waiting hook with those grants, not as keys into the terminal.
	await expect.poll(() => answers(page)).toEqual([expect.objectContaining({ hold: 'hold-1', allow: true, session: ['rule:Bash(rm -rf build)'], message: null })]);
	expect(await typed(page)).not.toContain('\r');
	expect(errors).toEqual([]);
});

test('Deny on a held permission prompt tells the agent the reason', async ({ page }) => {
	const errors = watchErrors(page);
	await startTask(page);

	await page.evaluate(() =>
		(window as any).__e2e.hookEvents.push({ hook_event_name: 'PermissionRequest', tool_name: 'Write', session_id: 's1', kingu_hold: 'hold-2', tool_input: { file_path: '/etc/hosts' } })
	);
	const card = page.getByRole('alertdialog', { name: 'Permission needed' }).first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	await expect(card.locator('pre')).toHaveText('/etc/hosts');
	// No suggestions: nothing to allow for the session.
	await expect(card.getByRole('button', { name: 'Allow for this session' })).toHaveCount(0);

	await card.getByRole('textbox', { name: /Why not\?/ }).fill('Write under ./tmp instead');
	await card.getByRole('button', { name: 'Deny' }).click();
	await expect(card).toHaveCount(0);
	await expect.poll(() => answers(page)).toEqual([expect.objectContaining({ hold: 'hold-2', allow: false, session: null, message: 'Write under ./tmp instead' })]);
	expect(await typed(page)).not.toContain('\x1b');
	expect(errors).toEqual([]);
});
