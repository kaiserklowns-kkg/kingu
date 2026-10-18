// problems.sortOrder for Monaco's Go to Next/Previous Problem (F8), which reads it from Monaco's
// configuration service like VS Code's MarkerNavigationService does.

import { untrack } from 'svelte';
import { settings } from '#lib/settings/settings.svelte.ts';

export function installProblemsSettings(): () => void {
	return $effect.root(() => {
		$effect(() => {
			const order = settings.get<string>('problems.sortOrder');
			untrack(() => void import('#lib/editor/monacoConfiguration.ts').then(({ updateMonacoConfiguration }) => updateMonacoConfiguration([['problems.sortOrder', order]])));
		});
	});
}
