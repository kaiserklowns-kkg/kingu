import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCM_MENU, SCM_MENU_TOP, scmMenu } from './scmMenu';

/** Every command id registered somewhere in the sources (`id: '…'` followed by its title). */
function registeredIds(): Set<string> {
	const ids = new Set<string>();
	const src = join(import.meta.dir, '..');
	for (const file of new Glob('**/*.{ts,svelte}').scanSync(src)) {
		if (file.endsWith('.test.ts')) continue;
		for (const m of readFileSync(join(src, file), 'utf8').matchAll(/id: '([\w.]+)',\s*title:/g)) ids.add(m[1]);
	}
	return ids;
}

test('the More Actions menu names registered commands only', () => {
	const ids = registeredIds();
	const all = [...SCM_MENU_TOP, ...SCM_MENU.flatMap(([, list]) => list.filter((x): x is string => x !== null))];
	expect(all.filter((id) => !ids.has(id))).toEqual([]);
});

test('menu nodes: top commands, a separator, then the submenus with their state', () => {
	const nodes = scmMenu({ enabled: (id) => id !== 'git.push', label: (id) => id.toUpperCase(), submenu: (key) => key });
	expect(nodes.slice(0, SCM_MENU_TOP.length).map((n) => n.type === 'item' && [n.id, n.text, n.enabled])).toContainEqual(['git.push', 'GIT.PUSH', false]);
	expect(nodes[SCM_MENU_TOP.length]).toEqual({ type: 'separator' });
	const stash = nodes.find((n) => n.type === 'submenu' && n.id === 'scmGit.menuStash');
	expect(stash && stash.type === 'submenu' && stash.items.filter((n) => n.type === 'separator')).toHaveLength(3);
});
