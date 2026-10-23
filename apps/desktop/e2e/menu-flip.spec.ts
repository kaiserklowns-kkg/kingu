import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

test('chat header submenu stays inside the window', async ({ page }) => {
	await openApp(page);

	const chat = page.getByRole('complementary', { name: 'Chat' });
	const more = chat.getByRole('button', { name: 'More actions' });
	await expect(more).toBeVisible();
	await more.click();

	const where = page.getByRole('menuitem', { name: 'Where the agent runs' });
	await expect(where).toBeVisible();
	await where.hover();

	const sub = page.getByRole('menu', { name: 'Where the agent runs' });
	await expect(sub).toBeVisible();
	const box = await sub.boundingBox();
	expect(box).toBeTruthy();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
