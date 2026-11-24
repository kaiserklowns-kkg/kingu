import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers';
import { watchErrors, type MockOpts } from './mock';

// "Retry with updated sandbox permissions" (VS Code 1.147): the sandbox stopped the run's Bash
// command, and the card offers to add what it needed and run it again in the sandbox
// (agent-host sandbox/retry.ts; PermissionCard.svelte, sandboxGrant.ts). The host side, with real
// sandbox-exec runs, is covered by agent-host test/sandbox-retry.test.ts.

async function blockedRun(page: Page, kind: NonNullable<MockOpts['sandboxRetry']>, settings: Record<string, unknown> = {}) {
	await openApp(page, undefined, settings, { sandboxRetry: kind });
	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Install the dependencies');
	await input.press('Enter');
	const card = chat.getByTestId('sandbox-grant');
	await expect(card).toBeVisible({ timeout: 10_000 });
	return chat;
}

const answers = (page: Page) => page.evaluate(() => (window as any).__e2e.agentAnswers as { requestId: string; decision: string }[]);
const userSettings = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('__kingu_e2e_settings') ?? '{}'));

test('a network block offers the retry with VS Code wording and names the rule', async ({ page }) => {
	const errors = watchErrors(page);
	const chat = await blockedRun(page, 'domain', { 'chat.agent.sandbox.network.allowedDomains': ['github.com'] });

	await expect(chat.getByText('Retry `Bash` command in the sandbox by allowing network access to registry.npmjs.org?')).toBeVisible();
	await expect(chat.getByTestId('sandbox-grant').locator('pre')).toContainText('npm view left-pad version');
	await expect(chat.getByTestId('sandbox-blocked-by').getByRole('listitem')).toHaveText(['Blocked by registry.npmjs.org: not in chat.agent.sandbox.network.allowedDomains']);
	// The key hints (Esc, ⏎) are part of the buttons' names.
	for (const name of [/^Skip\b/, /^Allow for This User$/, /^Allow for This Session\b/]) await expect(chat.getByRole('button', { name })).toBeVisible();

	// "Allow for This User" saves the domain to the user's settings first, keeping what was there.
	await chat.getByRole('button', { name: /^Allow for This User$/ }).click();
	await expect.poll(() => answers(page)).toEqual([expect.objectContaining({ requestId: 'sbx-1', decision: 'allow_user' })]);
	expect((await userSettings(page))['chat.agent.sandbox.network.allowedDomains']).toEqual(['github.com', 'registry.npmjs.org']);
	await expect(chat.getByTestId('sandbox-grant')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('a path block can be allowed for this session only, leaving the settings alone', async ({ page }) => {
	const errors = watchErrors(page);
	const chat = await blockedRun(page, 'path');

	await expect(chat.getByText('Allow sandbox path access and retry?')).toBeVisible();
	await expect(chat.getByTestId('sandbox-blocked-by').getByRole('listitem')).toHaveText([/Blocked by ~\/\.cache\/tool\/stamp/]);

	await chat.getByRole('button', { name: /^Allow for This Session\b/ }).click();
	await expect.poll(() => answers(page)).toEqual([expect.objectContaining({ requestId: 'sbx-1', decision: 'allow_always' })]);
	expect((await userSettings(page))['chat.agent.sandbox.fileSystem.userConfiguredPaths']).toBeUndefined();
	await expect(chat.getByTestId('sandbox-grant')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('Skip keeps the sandbox as it is', async ({ page }) => {
	const errors = watchErrors(page);
	const chat = await blockedRun(page, 'path');

	await chat.getByRole('button', { name: /^Skip\b/ }).click();
	await expect.poll(() => answers(page)).toEqual([expect.objectContaining({ requestId: 'sbx-1', decision: 'deny' })]);
	expect((await userSettings(page))['chat.agent.sandbox.fileSystem.userConfiguredPaths']).toBeUndefined();
	await expect(chat.getByTestId('sandbox-grant')).toHaveCount(0);
	expect(errors).toEqual([]);
});
