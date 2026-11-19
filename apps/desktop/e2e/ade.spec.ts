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

test('the Now page composer takes an optional task name with emoji', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });

	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const name = page.getByRole('combobox', { name: 'Task name' });
	await name.pressSequentially(':bug: crash');
	await expect(name).toHaveValue('🐛 crash');

	// Enter in the name moves on to the prompt; it does not start the task.
	await name.press('Enter');
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await expect(description).toBeFocused();
	expect((await calls(page)).worktree_create ?? 0).toBe(0);

	await description.fill('Fix the crash on save');
	await expect(page.getByText('kingu/bug-crash', { exact: true })).toBeVisible();
	await description.press('Enter');
	await expect.poll(async () => (await calls(page)).worktree_create ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test('the Quick Commands button runs the command in a new terminal tab', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.terminal.quickCommands': { Dev: 'bun run dev', Tests: 'bun test && echo done' } });
	await page.getByRole('button', { name: 'Open in Agents' }).click();

	// The main part runs the first command until another one was used.
	await page.getByRole('button', { name: /^Run Dev in a new terminal/ }).click();
	await expect(page.getByRole('tab', { name: /Dev/ })).toBeVisible();

	// The chevron lists every command; the one picked becomes the main button's.
	await page.getByRole('button', { name: 'Quick Commands', exact: true }).click();
	// The list searches label and command text; Enter runs the first match.
	const menu = page.getByRole('dialog', { name: 'Quick Commands' });
	await menu.getByRole('textbox', { name: 'Search' }).fill('echo');
	await expect(menu.getByRole('menuitem')).toHaveCount(1);
	await expect(menu.getByRole('menuitem').first()).toContainText('Tests');
	await menu.getByRole('textbox', { name: 'Search' }).press('Enter');
	await expect(page.getByRole('tab', { name: /Tests/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Run Tests in a new terminal/ })).toBeVisible();

	// The shell gets the line as typed (no quoting), each once.
	await expect.poll(async () => page.evaluate(() => (window as any).__e2e.writes.map((w: { data: string }) => w.data))).toEqual(expect.arrayContaining(['bun run dev\r', 'bun test && echo done\r']));
	const writes: string[] = await page.evaluate(() => (window as any).__e2e.writes.map((w: { data: string }) => w.data));
	expect(writes.filter((d) => d === 'bun test && echo done\r')).toHaveLength(1);
	expect(errors).toEqual([]);
});

test('a permission prompt of a terminal agent is answered from its card', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await description.fill('Clean the build folder');
	await description.press('Enter');
	await expect.poll(async () => (await calls(page)).agent_hook_settings ?? 0).toBeGreaterThan(0);

	// claude's PermissionRequest hook: the card asks, Allow presses Enter in that terminal.
	await page.evaluate(() => (window as any).__e2e.hookEvents.push({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 's1' }));
	const card = page.getByRole('alertdialog', { name: 'Permission needed' }).first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	await expect(card).toContainText('Bash');
	await card.getByRole('button', { name: 'Allow once' }).click();
	await expect(card).toHaveCount(0);
	await expect.poll(async () => page.evaluate(() => (window as any).__e2e.writes.map((w: { data: string }) => w.data))).toContain('\r');

	// Deny presses Esc.
	await page.evaluate(() => (window as any).__e2e.hookEvents.push({ hook_event_name: 'PermissionRequest', tool_name: 'Write', session_id: 's1' }));
	await expect(page.getByRole('alertdialog', { name: 'Permission needed' }).first()).toContainText('Write', { timeout: 10_000 });
	await page.getByRole('alertdialog', { name: 'Permission needed' }).first().getByRole('button', { name: 'Deny' }).click();
	await expect.poll(async () => page.evaluate(() => (window as any).__e2e.writes.map((w: { data: string }) => w.data))).toContain('\x1b');
	expect(errors).toEqual([]);
});

test('Add Command saves a quick command for every project or this one', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();

	for (const [label, command, project] of [['Dev', 'bun run dev', false], ['Seed', 'bun run seed', true]] as const) {
		await page.getByRole('button', { name: 'Quick Commands', exact: true }).click();
		await page.getByRole('dialog', { name: 'Quick Commands' }).getByRole('menuitem', { name: /Add Command/ }).click();
		const form = page.getByRole('form', { name: 'Add Quick Command' });
		await form.getByRole('textbox', { name: 'Label' }).fill(label);
		await form.getByRole('textbox', { name: 'Command' }).fill(command);
		if (project) await form.getByRole('radio', { name: 'This project' }).check();
		await form.getByRole('button', { name: 'Save' }).click();
		await expect(form).toHaveCount(0);
	}
	// The one saved last is the main button's; both are in the list.
	await expect(page.getByRole('button', { name: /^Run Seed in a new terminal/ })).toBeVisible();
	await page.getByRole('button', { name: 'Quick Commands', exact: true }).click();
	const menu = page.getByRole('dialog', { name: 'Quick Commands' });
	await expect(menu.getByRole('menuitem', { name: /^Dev/ })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: /^Seed/ })).toBeVisible();
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

test('Advanced → Parent task nests the new task without stacking it', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	const description = page.getByRole('textbox', { name: /Describe the task/ });
	await description.fill('Parent work');
	await description.press('Enter');
	await expect.poll(async () => page.evaluate(() => (window as any).__e2e.tasks.length)).toBeGreaterThan(0);
	const parent: string = await page.evaluate(() => (window as any).__e2e.tasks[0].slug);

	await page.getByRole('button', { name: 'Tasks', exact: true }).click();
	// The Now page's New task opened the folder composer, not this form.
	const childName = page.getByRole('combobox', { name: 'Task name' });
	await expect(childName).toHaveCount(0);
	await page.getByRole('button', { name: 'New Task', exact: true }).click();
	await childName.fill('Child work');
	await page.getByRole('button', { name: 'Advanced' }).click();
	await page.getByRole('combobox', { name: 'Parent task' }).selectOption({ label: 'Parent work' });
	await page.getByRole('button', { name: 'Create and start', exact: true }).click();

	await expect.poll(async () => page.evaluate(() => (window as any).__e2e.tasks.find((t: { title: string }) => t.title === 'Child work')?.parent ?? null)).toBe(parent);
	// Nested only: the child starts from the folder's base, not the parent's branch.
	const base = await page.evaluate(() => (window as any).__e2e.tasks.find((t: { title: string }) => t.title === 'Child work')?.base);
	expect(base).not.toBe(`kingu/${parent}`);
	expect(errors).toEqual([]);
});

test('a hidden worktrees card lists worktrees Kingu did not make and shows one', async ({ page }) => {
	const errors = watchErrors(page);
	const wt = (path: string, branch: string) => ({ path, head: 'abc1234', branch, slug: null, bare: false, detached: false, locked: false, prunable: false });
	await openApp(page, READY, { 'kingu.worktree.externalVisibility': 'hide' }, { worktrees: [wt('/tmp/kingu-e2e', 'main'), wt('/tmp/elsewhere/spike', 'spike'), wt('/tmp/kingu-e2e/.claude/worktrees/x', 'claude-x')] });
	await page.getByRole('button', { name: 'Open in Agents' }).click();

	const card = page.getByRole('button', { name: 'Hidden worktrees: 2' });
	await expect(card).toBeVisible();
	await card.click();
	const dialog = page.getByRole('dialog', { name: 'Worktrees Kingu Did Not Create' });
	await dialog.getByRole('textbox', { name: 'Search path or branch' }).fill('spike');
	await expect(dialog.getByRole('button', { name: 'Show' })).toHaveCount(1);
	await dialog.getByRole('button', { name: 'Show' }).click();

	// It moves to the side bar; the card counts the one left.
	await expect(page.getByRole('button', { name: 'Hidden worktrees: 1' })).toBeVisible();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(page.getByRole('button', { name: /^spike/ })).toBeVisible();
	expect(errors).toEqual([]);
});

test('the task board searches titles, branches and agents', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	for (const text of ['Fix login on Safari', 'Write release notes']) {
		await page.getByRole('button', { name: 'Now', exact: true }).click();
		const description = page.getByRole('textbox', { name: /Describe the task/ });
		// With no task yet, Now is the composer itself; after that it is the Now page.
		if (!(await description.isVisible())) await page.getByRole('button', { name: 'New task', exact: true }).click();
		await description.fill(text);
		await description.press('Enter');
		await expect.poll(async () => page.evaluate((t) => (window as any).__e2e.tasks.some((x: { title: string }) => x.title === t), text)).toBe(true);
	}
	await page.getByRole('button', { name: 'Tasks', exact: true }).click();
	const search = page.getByRole('textbox', { name: 'Search tasks, branches, agents' });
	await search.fill('safari');
	await expect(page.getByText('1 of 2 tasks')).toBeVisible();
	await expect(page.getByRole('main').getByText('Write release notes')).toHaveCount(0);
	await search.press('Escape');
	await expect(page.getByText('2 tasks', { exact: true })).toBeVisible();
	// The PR filter: neither task has a pull request.
	const pr = page.getByRole('combobox', { name: 'PR status' });
	await pr.selectOption('open');
	await expect(page.getByText('0 of 2 tasks')).toBeVisible();
	await pr.selectOption('none');
	await expect(page.getByText('2 of 2 tasks')).toBeVisible();
	// The agent-status columns: Idle (finished and seen) shows only when asked for.
	await page.getByRole('button', { name: 'Agent status' }).click();
	await expect(page.getByRole('region', { name: 'Idle' })).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'Show idle' }).check();
	await expect(page.getByRole('region', { name: 'Idle' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('a GitHub issue opens in a drawer to close, label, assign and comment', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page);
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'Issues', exact: true }).click();
	await page.getByRole('button', { name: 'All open' }).click();
	await page.getByRole('button', { name: 'Login fails on Safari' }).click();

	const drawer = page.getByRole('complementary', { name: 'Issue #12' });
	await expect(drawer.getByText('Steps to reproduce…')).toBeVisible();
	await drawer.getByRole('textbox', { name: 'Add label' }).fill('safari');
	await drawer.getByRole('textbox', { name: 'Add label' }).press('Enter');
	await expect(drawer.getByRole('button', { name: 'Remove label safari' })).toBeVisible();
	await drawer.getByRole('button', { name: 'Remove label bug' }).click();
	await expect(drawer.getByRole('button', { name: 'Remove label bug' })).toHaveCount(0);
	await drawer.getByRole('button', { name: 'Assign me' }).click();
	await expect(drawer.getByText('@e2e')).toBeVisible();

	await drawer.getByRole('textbox', { name: 'Comment' }).fill('Fixed in the next build');
	await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
	await expect(drawer.getByText('Fixed in the next build')).toBeVisible();
	await expect(drawer.getByRole('textbox', { name: 'Comment' })).toHaveValue('');

	// Edit the title and description; Escape leaves the edit, not the drawer.
	await drawer.getByRole('button', { name: 'Edit', exact: true }).click();
	await drawer.getByRole('textbox', { name: 'Title' }).fill('Login fails on Safari 18');
	await drawer.getByRole('textbox', { name: 'Description' }).fill('Only on 18.1');
	await drawer.getByRole('button', { name: 'Save' }).click();
	await expect(drawer.getByRole('heading', { name: 'Login fails on Safari 18' })).toBeVisible();
	await expect(drawer.getByText('Only on 18.1')).toBeVisible();
	await drawer.getByRole('button', { name: 'Edit', exact: true }).click();
	await drawer.getByRole('textbox', { name: 'Title' }).press('Escape');
	await expect(drawer.getByRole('textbox', { name: 'Title' })).toHaveCount(0);
	await expect(drawer).toBeVisible();

	await drawer.getByRole('button', { name: 'Close issue' }).click();
	await expect(drawer.getByText('Closed', { exact: true })).toBeVisible();
	await drawer.getByRole('button', { name: 'Reopen issue' }).click();
	await expect(drawer.getByText('Open', { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test('the composer nests a new task under a parent', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, { 'kingu.agent.cli': 'claude' });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	for (const [text, parent] of [['Parent work', ''], ['Child work', 'Parent work']]) {
		await page.getByRole('button', { name: 'Now', exact: true }).click();
		const description = page.getByRole('textbox', { name: /Describe the task/ });
		if (!(await description.isVisible())) await page.getByRole('button', { name: 'New task', exact: true }).click();
		if (parent) await page.getByRole('combobox', { name: 'Parent task' }).selectOption({ label: parent });
		await description.fill(text);
		await description.press('Enter');
		await expect.poll(async () => page.evaluate((t) => (window as any).__e2e.tasks.some((x: { title: string }) => x.title === t), text)).toBe(true);
	}
	const tasks: { title: string; slug: string; parent?: string }[] = await page.evaluate(() => (window as any).__e2e.tasks);
	const parentSlug = tasks.find((x) => x.title === 'Parent work')!.slug;
	expect(tasks.find((x) => x.title === 'Child work')?.parent).toBe(parentSlug);
	expect(errors).toEqual([]);
});

test('a Jira issue opens in a read-and-comment drawer', async ({ page }) => {
	const errors = watchErrors(page);
	await openApp(page, READY, {}, { jira: true });
	await page.getByRole('button', { name: 'Open in Agents' }).click();
	await page.getByRole('button', { name: 'Issues', exact: true }).click();
	await page.getByRole('button', { name: 'Rotate the staging keys' }).click();

	const drawer = page.getByRole('complementary', { name: 'Issue OPS-7' });
	await expect(drawer.getByText('Keys expire on Friday.')).toBeVisible();
	await expect(drawer.getByText('In Progress')).toBeVisible();
	await drawer.getByRole('textbox', { name: 'Comment' }).fill('Rotated today');
	await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
	await expect(drawer.getByText('Rotated today')).toBeVisible();
	await page.keyboard.press('Escape');
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

	// The picker button: defaults first, a search, Enter puts it at the end.
	await page.getByRole('button', { name: 'Pick an emoji' }).click();
	const picker = page.getByRole('dialog', { name: 'Pick an emoji' });
	await expect(picker.getByRole('option').first()).toContainText(':rocket:');
	await picker.getByRole('textbox', { name: 'Search emoji' }).fill('tada');
	await picker.getByRole('textbox', { name: 'Search emoji' }).press('Enter');
	await expect(picker).toHaveCount(0);
	await expect(name).toHaveValue('🐛 fix 🚀 🎉 ');

	// Escape closes the list, not the form.
	await name.pressSequentially(':sm');
	await expect(list).toBeVisible();
	await name.press('Escape');
	await expect(list).toHaveCount(0);
	await expect(name).toBeVisible();
	expect(errors).toEqual([]);
});
