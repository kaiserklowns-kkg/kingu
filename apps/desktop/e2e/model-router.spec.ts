import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

// Model routers (VS Code 1.147): with `chat.copilot.modelRouter.enabled`, each router in
// `~/.agents/model-routers/` is a model of every Arkai provider (`<provider>/model-router:<name>`);
// the agent host routes each turn (agent-host src/arkai/modelRouter.ts).
test('an Arkai chat can pick a model router in the model picker', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.runtime': 'arkai', 'chat.copilot.modelRouter.enabled': true }, { arkai: true });

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const model = chat.getByRole('button', { name: /Model: / });
	await model.click();
	const menu = page.getByRole('listbox', { name: 'Model' });
	await expect(menu.getByRole('option', { name: /claude-opus-4-6/ })).toBeVisible({ timeout: 5_000 });
	const router = menu.getByRole('option', { name: /Daily Driver/ });
	await expect(router).toBeVisible();
	await expect(router).toContainText('model router');
	await router.click();
	await expect(model).toHaveAccessibleName(/Model: Daily Driver/);
	await expect.poll(async () => (await calls(page)).arkai_model_routers).toBeGreaterThanOrEqual(1);
	expect(errors).toEqual([]);
});
