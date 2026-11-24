// Chat composer features (docs/AI-SURFACES.md, Send Later / side questions / drafts):
//   VS Code 1.147's Send Later: schedule what is typed from the Send button's menu, the "Scheduled"
//     rows over the input (Send Now, Cancel Schedule), and Kingu-only `/later <when> <message>`.
//   Orca 1.4.272's `/btw` / `/side`: a side question to a fork beside the chat, in the side chat drawer.
//   VS Code 1.147's saved drafts: a chat keeps its unsent input; the history marks it, Delete Draft.

import { expect, test, type Page } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

/** A started chat with the mock agent's first answer. */
async function startChat(page: Page) {
	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Hello agent');
	await input.press('Enter');
	await expect(chat.getByText('Hello from the mock agent').first()).toBeVisible();
	return { chat, input: chat.getByRole('combobox').first() };
}

const scheduled = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('kingu.chat.scheduled') ?? '[]') as { label: string; runAt: number }[]);

test('Send Later from the Send menu: a Scheduled row, kept on this machine, then Send Now', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	const { chat, input } = await startChat(page);

	await input.fill('check the build');
	// A real right-click: the floating workspace's toggle keeps clear of the composer (Orca's keep-clear).
	await chat.getByRole('button', { name: 'Send (Enter)' }).click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Send Later...' }).click();
	await page.getByRole('menuitem', { name: 'In 5 Minutes' }).click();

	const rows = chat.getByRole('region', { name: '1 Scheduled Message' });
	await expect(rows).toBeVisible();
	await expect(rows.getByText('check the build')).toBeVisible();
	await expect(rows.getByText(/Sends in [45] minutes/)).toBeVisible();
	await expect(input).toHaveValue('');
	const kept = await scheduled(page);
	expect(kept.map((s) => s.label)).toEqual(['check the build']);
	expect(kept[0].runAt - Date.now()).toBeGreaterThan(3 * 60_000);

	const sentBefore = (await calls(page)).agent_send ?? 0;
	await rows.getByText('check the build').hover();
	await rows.getByRole('button', { name: 'Send Now' }).click();
	await expect(rows).toHaveCount(0);
	await expect.poll(async () => (await calls(page)).agent_send ?? 0).toBe(sentBefore + 1);
	expect(await scheduled(page)).toEqual([]);
	expect(errors).toEqual([]);
});

test('Kingu-only /later <when> <message> schedules from the input; Cancel Schedule drops it', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	const { chat, input } = await startChat(page);

	await input.fill('/later whenever run it');
	await input.press('Enter');
	await expect(page.getByText(/Say when first/)).toBeVisible();

	await input.fill('/later 2h run the tests');
	await input.press('Enter');
	const rows = chat.getByRole('region', { name: '1 Scheduled Message' });
	await expect(rows.getByText('run the tests')).toBeVisible();
	await expect(rows.getByText(/Sends in (1|2) hours?/)).toBeVisible();
	await rows.getByText('run the tests').hover();
	await rows.getByRole('button', { name: 'Cancel Schedule' }).click();
	await expect(rows).toHaveCount(0);
	expect(await scheduled(page)).toEqual([]);
	expect(errors).toEqual([]);
});

test('/btw asks a side question in a fork beside the chat, never sent to the chat itself', async ({ page }) => {
	const errors = watchErrors(page);
	// Claude Code: an agent Kingu can fork (rewind), so `/btw` is Kingu's, not the agent's.
	await openApp(page, READY, { 'kingu.agent.runtime': 'claude' });
	const { chat, input } = await startChat(page);

	// The `/` menu lists Orca's rows with what they do.
	await input.fill('/bt');
	await expect(page.getByRole('option', { name: /btw.*Ask a side question in a fork beside this chat/ })).toBeVisible();

	const startsBefore = (await calls(page)).agent_start ?? 0;
	const sendsBefore = (await calls(page)).agent_send ?? 0;
	await input.fill('/btw what does foo do?');
	await input.press('Enter');

	const drawer = chat.getByRole('region', { name: 'Side Chat' });
	await expect(drawer).toBeVisible();
	await expect.poll(async () => (await calls(page)).chat_fork ?? 0).toBe(1);
	// The fork runs on its own: a new run answers in the drawer; the chat got nothing.
	await expect.poll(async () => (await calls(page)).agent_start ?? 0).toBe(startsBefore + 1);
	// The question went to the fork's run (the mock's starts), and its answer shows in the drawer.
	const starts = await page.evaluate(() => (window as any).__e2e.starts as { prompt: string }[]);
	expect(starts.at(-1)?.prompt).toContain('what does foo do?');
	await expect(drawer.getByText('Hello from the mock agent')).toBeVisible();
	expect((await calls(page)).agent_send ?? 0).toBe(sendsBefore);
	await expect(input).toHaveValue('');
	expect(errors).toEqual([]);
});

test('a chat keeps its unsent draft; the history marks it and Delete Draft forgets it', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	const { chat, input } = await startChat(page);

	await input.fill('my unsent idea');
	// Saved after a short pause in typing.
	await expect.poll(() => page.evaluate(() => localStorage.getItem('kingu.chat.drafts') ?? '')).toContain('my unsent idea');

	// The history marks the chat that keeps unsent input; opening it resumes the draft.
	await chat.getByRole('button', { name: 'Show Agent Sessions Sidebar' }).first().click();
	const row = chat.getByRole('listitem').filter({ hasText: 'Hello agent' });
	await expect(row.getByText('Draft: my unsent idea')).toBeVisible();
	await row.getByText('Hello agent').click();
	await expect(chat.getByRole('combobox').first()).toHaveValue('my unsent idea');

	await chat.getByRole('button', { name: 'Show Agent Sessions Sidebar' }).first().click();
	await row.hover();
	await row.getByRole('button', { name: 'Delete Draft' }).click();
	await expect(row.getByText(/^Draft:/)).toHaveCount(0);
	await row.getByText('Hello agent').click();
	await expect(chat.getByRole('combobox').first()).toHaveValue('');
	expect(await page.evaluate(() => localStorage.getItem('kingu.chat.drafts') ?? '')).not.toContain('my unsent idea');
	expect(errors).toEqual([]);
});
