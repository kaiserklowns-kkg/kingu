import { expect, test, type Page } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

// VS Code 1.146 Inbox mode (Orca's "Needs you") and VS Code 1.145 cron schedules, through the UI.

/** A task whose claude waits on a permission prompt (its PermissionRequest hook). */
async function waitingTask(page: Page, settings: Record<string, unknown>) {
	await openApp(page, READY, { 'kingu.agent.cli': 'claude', ...settings });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await description.fill('Clean the build folder');
	await description.press('Enter');
	await expect.poll(async () => (await calls(page)).agent_hook_settings ?? 0).toBeGreaterThan(0);
	await page.evaluate(() =>
		(window as any).__e2e.hookEvents.push({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 's1', kingu_hold: 'hold-1', tool_input: { command: 'rm -rf build' } })
	);
	await expect(page.getByRole('alertdialog', { name: 'Permission needed' }).first()).toBeVisible({ timeout: 10_000 });
}

test('Inbox is off by default, like VS Code', async ({ page }) => {
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Inbox', exact: true })).toHaveCount(0);
});

test('a task waiting on approval is in the Inbox; dismiss, undo and snooze', async ({ page }) => {
	const errors = watchErrors(page);
	await waitingTask(page, { 'sessions.list.inboxEnabled': true });

	await page.getByRole('button', { name: /^Inbox/ }).first().click();
	await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
	const inbox = page.getByRole('region', { name: 'Inbox' });
	const row = inbox.getByRole('listitem').filter({ hasText: /Clean the build/ });
	await expect(row).toBeVisible();
	await expect(row.getByText('Approval', { exact: true })).toBeVisible();
	await expect(row.getByText(/^Task · /)).toBeVisible();

	// Dismiss from Inbox: Acknowledged (collapsed), not stopped; the agent's prompt is still there.
	await row.getByRole('button', { name: 'Dismiss from Inbox' }).click();
	await expect(inbox.getByText('Nothing needs your attention right now.')).toBeVisible();
	const acknowledged = page.getByRole('region', { name: 'Acknowledged' });
	await expect(acknowledged.getByRole('button', { name: /Acknowledged/ })).toHaveAttribute('aria-expanded', 'false');
	await acknowledged.getByRole('button', { name: /Acknowledged/ }).click();
	await expect(acknowledged.getByRole('listitem').filter({ hasText: /Clean the build/ })).toBeVisible();
	expect(await page.evaluate(() => (window as any).__e2e.permissionAnswers)).toEqual([]);

	// Undo puts it back.
	await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
	await expect(row).toBeVisible();

	// Snooze until new activity: On hold, with the reason shown.
	await row.getByRole('button', { name: 'Snooze…' }).click();
	await page.getByRole('menuitem', { name: 'Until New Activity' }).click();
	const onHold = page.getByRole('region', { name: 'On hold' });
	await expect(onHold.getByText(/Snoozed until new activity/)).toBeVisible();
	await onHold.getByRole('button', { name: 'Return to Inbox' }).click();
	await expect(row).toBeVisible();

	// Triage survives a reload (VS Code: "Triage choices persist after reloading the window").
	await row.getByRole('button', { name: 'Put on Hold' }).click();
	await expect(page.getByRole('region', { name: 'On hold' }).getByText('On hold', { exact: false }).first()).toBeVisible();
	const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kingu.sessionInbox.triage') ?? '{}'));
	expect(Object.values(saved)).toEqual([{ kind: 'hold' }]);
	expect(errors).toEqual([]);
});

test('a cron automation: five fields, VS Code description, created off in Disabled automations', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: /^Automations/ }).first().click();
	await page.getByRole('button', { name: 'New', exact: true }).click();

	const form = page.getByRole('form', { name: 'New automation' });
	await form.getByRole('textbox', { name: 'Automation name' }).fill('Daily summary');
	await form.getByRole('textbox', { name: 'Prompt for the agent' }).fill('Summarize commits from the last 24 hours. Do not modify files.');
	await form.getByRole('combobox', { name: 'Trigger' }).selectOption('cron');
	const create = form.getByRole('button', { name: 'Create' });
	await expect(form.getByText('Enter all five fields, or paste a complete five-field expression.')).toBeVisible();
	await expect(create).toBeDisabled();

	// Pasting a whole expression into one field fills all five.
	await form.getByRole('textbox', { name: 'Minute' }).evaluate((el) => {
		const data = new DataTransfer();
		data.setData('text', '0 9,17 * * MON-FRI');
		el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	});
	await expect(form.getByRole('textbox', { name: 'Day of week' })).toHaveValue('MON-FRI');
	await expect(form.getByTestId('cron-description')).toHaveText(/^Runs at 9:00\sAM and 5:00\sPM on Monday through Friday\.$/);
	await expect(form.getByText('Evaluated in local time.')).toBeVisible();

	// A step from a single value is refused, as in VS Code.
	await form.getByRole('textbox', { name: 'Minute' }).fill('5/15');
	await expect(form.getByText("Minute steps require '*' or a range such as 0-59.")).toBeVisible();
	await expect(create).toBeDisabled();
	await form.getByRole('textbox', { name: 'Minute' }).fill('0');

	// Enabled is cleared by default: nothing is scheduled until the user turns it on.
	await expect(form.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked();
	await create.click();
	await expect(form).toHaveCount(0);
	const saved = await page.evaluate(() => (window as any).__e2e.automations);
	expect(saved).toEqual([expect.objectContaining({ name: 'Daily summary', schedule: '0 9,17 * * MON-FRI', trigger: 'cron', enabled: false, time_zone: expect.any(String) })]);

	const disabled = page.getByRole('region', { name: 'Disabled automations' });
	await disabled.getByRole('button', { name: /Disabled automations/ }).click();
	await expect(disabled.getByText(/Runs at 9:00\sAM and 5:00\sPM on Monday through Friday\./)).toBeVisible();
	expect(errors).toEqual([]);
});

test('Enabled on create asks first, and a declined confirm leaves it off', async ({ page }) => {
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: /^Automations/ }).first().click();
	await page.getByRole('button', { name: 'New', exact: true }).click();
	const form = page.getByRole('form', { name: 'New automation' });
	await form.getByRole('textbox', { name: 'Automation name' }).fill('Weekly triage');
	await form.getByRole('textbox', { name: 'Prompt for the agent' }).fill('Triage new issues.');
	await form.getByRole('combobox', { name: 'Trigger' }).selectOption('weekly');
	await form.getByRole('checkbox', { name: 'Enabled' }).check();
	// The native confirm answers "Cancel" (no button): it stays off.
	await form.getByRole('button', { name: 'Create' }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__e2e.messages.length)).toBeGreaterThan(0);
	const ask = await page.evaluate(() => (window as any).__e2e.messages.at(-1));
	expect(ask.title).toBe('Turn On Automation');
	await expect.poll(() => page.evaluate(() => (window as any).__e2e.automations)).toEqual([expect.objectContaining({ trigger: 'weekly', schedule: expect.stringMatching(/^0 9 \* \* \d$/), enabled: false })]);
});

test('chat.automations.enabled off hides Automations', async ({ page }) => {
	await openApp(page, READY, { 'chat.automations.enabled': false });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Automations/ })).toHaveCount(0);
});
