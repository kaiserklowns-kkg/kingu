import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { openApp } from './helpers';
import { READY, watchErrors } from './mock';

/**
 * The real thing in the browser flow: this picker's model rows are named by the installed
 * OpenCode CLI through the live bridge (e2e/live-bridge.ts → the real agent host `main.ts`).
 * No fixture answers the model ask; the page's Rust domains stay mock.
 */
const opencodeOnPath = (() => {
	try {
		execFileSync('which', ['opencode']);
		return true;
	} catch {
		return false;
	}
})();

test('the model picker lists what the real OpenCode runtime names', async ({ page }) => {
	test.skip(!opencodeOnPath, 'the OpenCode CLI is not installed');
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { liveModels: true });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const target = chat.getByRole('button', { name: 'Agent: Claude Code' });
	await target.click();
	await page.getByRole('option', { name: 'OpenCode' }).click();
	const model = chat.getByRole('button', { name: /Model: / });
	await model.click();

	// The rows come from the real agent; a live answer names its models with the runtime's prefix.
	const option = page.locator('[role="option"]').filter({ hasText: /OpenCode\// });
	await option.first().waitFor({ timeout: 5_000 });
	
	// Picking a real model lands it on the chip.
	await option.first().click();
	await expect(model).toHaveAccessibleName(/Model: OpenCode\//);
	// A reopen asks nothing new (the cache answers): the real rows are still there.
	await model.click();
	await expect(option.first()).toBeVisible({ timeout: 3_000 });
	expect(errors).toEqual([]);
});

test('a real OpenCode session answers a sent chat message', async ({ page }) => {
	test.setTimeout(180_000) // a real model answers on its own clock (slow free-model queues)
	test.skip(!opencodeOnPath, 'the OpenCode CLI is not installed');
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { liveModels: true });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	// Real runtime, real model (the first of what the real CLI named), real first prompt.
	await chat.getByRole('button', { name: 'Agent: Claude Code' }).click();
	await page.getByRole('option', { name: 'OpenCode' }).click();
	const model = chat.getByRole('button', { name: /Model: / });
	await model.click();
	const option = page.locator('[role="option"]').filter({ hasText: /OpenCode\// });
	await option.first().waitFor({ timeout: 5_000 });
	await option.first().click();
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Reply with exactly the word pineapple and nothing else.');
	await input.press('Enter');

	// The live answer lands as its own message in the chat wall (the user's prompt names the word
	// too, so match the whole assistant paragraph, which is the word alone — ChatMarkdown's node).
	await expect(chat.locator('.kg-md p').filter({ hasText: /^pineapple$/i })).toBeVisible({ timeout: 170_000 });
	expect(errors).toEqual([]);
});
