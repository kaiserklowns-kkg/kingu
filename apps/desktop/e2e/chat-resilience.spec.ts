import { expect, test, type Page } from '@playwright/test';
import { calls, openApp } from './helpers';
import { watchErrors } from './mock';

// Chat resilience (Orca 1.4.271 / 1.4.272): a chat Kingu's exit cut off offers Resume, a chat
// that stopped on a usage limit offers Continue and an automatic continue, and Delete asks with
// "don't ask again". The Rust side (chats.rs: the checkpoint, chat_cut_off) has cargo tests.

const NOW = Date.now();
const cutChat = {
	id: 'c-e2e-cut',
	title: 'Refactor the auth module',
	title_auto: false,
	prompt: 'Refactor the auth module',
	cwd: { kind: 'folder' },
	session_id: 'sess-cut',
	model: null,
	permission_mode: null,
	runtime: 'claude',
	created_at: NOW - 60_000,
	updated_at: NOW - 30_000,
	last_run: null,
	working: true
};

/** Opens a saved chat from Home's Continue list. */
async function openChat(page: Page, title: string) {
	await page.getByRole('region', { name: 'Home' }).getByRole('button', { name: new RegExp(`^${title}`) }).click();
}

const starts = (page: Page) => page.evaluate(() => (window as any).__e2e.starts as { prompt: string; resume: string | null }[]);

test('a chat Kingu crashed in the middle of offers Resume, with the reply it had streamed', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, undefined, {}, { chats: [cutChat], cutOff: { crash: true, partial: 'Step 1 is done. Next I will move' } });

	// One notification for the folder…
	await page.getByRole('button', { name: /^Notifications/ }).click();
	await expect(page.getByText('"Refactor the auth module" was working when Kingu closed unexpectedly.')).toBeVisible();
	await page.keyboard.press('Escape');
	// …and the row in the chat.
	await openChat(page, 'Refactor the auth module');
	const chat = page.getByRole('complementary', { name: 'Chat' });
	const notice = chat.locator('[data-chat-notice="interrupted"]');
	await expect(notice).toBeVisible();
	await expect(notice).toHaveAttribute('data-crash', 'true');
	await expect(notice).toContainText('The reply it was writing was saved');

	await notice.getByRole('button', { name: 'Continue' }).click();
	await expect.poll(async () => (await starts(page)).length).toBe(1);
	const [start] = await starts(page);
	expect(start.resume).toBe('sess-cut');
	expect(start.prompt).toContain("Kingu restarted, so your previous reply was cut off partway through.");
	expect(start.prompt).toContain('<cut-off-reply>\nStep 1 is done. Next I will move\n</cut-off-reply>');
	await expect(notice).toBeHidden();
	expect(errors).toEqual([]);
});

test('with resume-on-restart on, the cut-off chat continues by itself', async ({ page }) => {
	await openApp(page, undefined, { 'kingu.chat.resumeWorkOnRestart': true }, { chats: [cutChat], cutOff: { crash: false, partial: null } });
	await expect.poll(async () => (await starts(page)).length).toBe(1);
	const [start] = await starts(page);
	expect(start.resume).toBe('sess-cut');
	expect(start.prompt).not.toContain('<cut-off-reply>');
	await expect(page.getByRole('complementary', { name: 'Chat' }).locator('[data-chat-notice="interrupted"]')).toBeHidden();
});

test('a turn that stops on the usage limit offers Continue and an automatic continue', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, undefined, {}, { usageLimit: "You've hit your session limit · resets 11:59pm (Pacific/Kiritimati)" });
	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Write the tests');
	await input.press('Enter');

	const row = chat.locator('[data-chat-notice="usage-limit"]');
	await expect(row).toBeVisible();
	await expect(row).toContainText(/usage limit reached/);
	await expect(row).toHaveAttribute('data-phase', 'waiting');
	await expect(row).toContainText(/Kingu will continue this chat at/);

	// Cancel keeps this chat manual; it can be undone.
	await row.getByRole('button', { name: 'Cancel' }).click();
	await expect(row).toContainText("Kingu won't continue this chat automatically.");
	await row.getByRole('button', { name: 'Continue automatically' }).click();
	await expect(row).toContainText(/Kingu will continue this chat at/);

	// Continue now: Orca's message, into the open session.
	await row.getByRole('button', { name: 'Continue' }).click();
	await expect.poll(async () => (await starts(page)).map((s) => s.prompt)).toContain('Continue where you left off.');
	expect(errors).toEqual([]);
});

test('Delete asks, and "Don\'t Ask Again" turns the question off', async ({ page }) => {
	const idle = { ...cutChat, id: 'c-e2e-old', title: 'Old chat', working: false };
	await openApp(page, undefined, {}, { chats: [idle] });
	const chat = page.getByRole('complementary', { name: 'Chat' });
	await openChat(page, 'Old chat');
	// The native message box answers its second button: "Delete, Don't Ask Again".
	await page.evaluate(() => ((window as any).__e2e.messageAnswer = 1));
	await chat.getByRole('button', { name: 'Views and More Actions...' }).click();
	await page.getByRole('menuitem', { name: 'Delete chat' }).click();
	await expect.poll(async () => (await calls(page)).chat_transcript_delete ?? 0).toBe(1);
	const asked = await page.evaluate(() => (window as any).__e2e.messages as { buttons: string[] }[]);
	expect(asked.at(-1)?.buttons).toEqual(['Delete', "Delete, Don't Ask Again", 'Cancel']);
	await expect(page.getByRole('region', { name: 'Home' }).getByRole('button', { name: /^Old chat/ })).toBeHidden();
	// Asked once: the next delete would not ask (kingu.chat.confirmDelete is off now).
	await expect.poll(async () => (await page.evaluate(() => sessionStorage.getItem('__kingu_e2e_settings'))) ?? '').toMatch(/"kingu\.chat\.confirmDelete":\s*false/);
});
