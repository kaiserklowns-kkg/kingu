import { expect, test } from '@playwright/test';
import { calls, openApp } from './helpers';
import { READY, watchErrors } from './mock';

test('switches to the Agents layout and opens the task board', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Tasks', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Task Board' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('creates a task from the Now page', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await description.fill('E2E Task');
	await description.press('Enter');

	await expect.poll(async () => (await calls(page)).worktree_create ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test('the Agents layout opens browser tabs from the tab row', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();

	// "+" shows on a page too (Orca's create menu); a new tab leaves the page for the worktree.
	await page.getByRole('button', { name: 'New Tab', exact: true }).click();
	await page.getByRole('menuitem', { name: /New Browser Tab/ }).click();

	const bar = page.getByRole('textbox', { name: 'Address' });
	await expect(bar).toBeVisible();
	await expect(page.getByRole('tab', { name: /^New Tab/ })).toBeVisible();

	await page.getByRole('button', { name: 'New Tab', exact: true }).click();
	await page.getByRole('menuitem', { name: /New Browser Tab/ }).click();
	await expect(page.getByRole('tab', { name: /^New Tab/ })).toHaveCount(2);
	expect(errors).toEqual([]);
});

test('the new-tab menu makes a Markdown tab and previews it', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New Tab', exact: true }).click();

	const menu = page.getByRole('dialog', { name: 'New Tab' });
	await expect(menu.getByRole('menuitem', { name: /New Markdown/ })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: /Open Markdown/ })).toBeVisible();
	await menu.getByRole('textbox', { name: 'Search' }).fill('markdown');
	await menu.getByRole('textbox', { name: 'Search' }).press('Enter');
	await expect(page.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();

	// A saved Markdown file opens as a tab and ⇧⌘V renders it in place.
	await page.getByRole('treeitem', { name: 'README.md' }).dblclick();
	await page.getByRole('tab', { name: /README\.md/ }).click();
	await page.keyboard.press('Meta+Shift+V');
	await expect(page.getByRole('heading', { name: 'Kingu E2E' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('an issue URL in the task name is looked up and linked', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'Tasks', exact: true }).click();
	await page.getByRole('button', { name: 'New Task', exact: true }).click();

	const name = page.getByRole('combobox', { name: 'Task name' });
	await name.fill('https://github.com/acme/app/issues/12');
	const offer = page.getByRole('button', { name: /Link acme\/app#12: Login fails on Safari/ });
	await expect(offer).toBeVisible();

	// Enter takes the link instead of creating a task named after the URL.
	await name.press('Enter');
	await expect(name).toHaveValue('Login fails on Safari');
	await expect(page.getByLabel('Linked issue acme/app#12: Login fails on Safari')).toBeVisible();
	expect((await calls(page)).worktree_create ?? 0).toBe(0);

	// Removing the link clears the name it gave.
	await page.getByRole('button', { name: 'Remove the linked issue' }).click();
	await expect(name).toHaveValue('');
	expect(errors).toEqual([]);
});

test('emoji shortcodes in the task name turn into emoji and name the branch', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'Tasks', exact: true }).click();
	await page.getByRole('button', { name: 'New Task', exact: true }).click();

	const name = page.getByRole('combobox', { name: 'Task name' });
	// A closed shortcode becomes its emoji as it is typed.
	await name.pressSequentially(':bug: fix');
	await expect(name).toHaveValue('🐛 fix');

	// `:rocke` lists matches; Enter takes the first instead of creating the task.
	await name.pressSequentially(' :rocke');
	const list = page.getByRole('listbox', { name: 'Emoji' });
	await expect(list.getByRole('option').first()).toContainText(':rocket:');
	await name.press('Enter');
	await expect(name).toHaveValue('🐛 fix 🚀 ');
	await expect(list).toHaveCount(0);
	// The branch spells the emoji out (Orca: 🚀 → rocket).
	await expect(page.getByText('→ kingu/bug-fix-rocket')).toBeVisible();
	expect((await calls(page)).worktree_create ?? 0).toBe(0);

	// Escape closes the list, not the form.
	await name.pressSequentially(':sm');
	await expect(list).toBeVisible();
	await name.press('Escape');
	await expect(list).toHaveCount(0);
	await expect(name).toBeVisible();
	expect(errors).toEqual([]);
});
