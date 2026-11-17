// Workspace Cleanup, automatic runs: opt-in (`kingu.workspaceCleanup.auto`, off by default). While a
// window is open and the setting is on, it looks once an hour (and shortly after opening) and, when a
// rule is on for the open folder, runs the same cleanup as `kingu cleanup run`: the rules decide, the
// normal removal (or archive) does it, and what was removed/archived is flashed and listed under Activity. Other windows
// run their own folders; a folder two windows share is safe because a removed task is gone for both.
import { settings } from '#lib/settings/settings.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { AUTO_FIRST_MS, autoRunDue } from './autoCleanup';
import { cleanup } from './cleanup.svelte';

export const AUTO_CLEANUP_ID = 'kingu.workspaceCleanup.auto';
/** How often the schedule is looked at; `autoRunDue` decides whether a run is due. */
const POLL_MS = 5 * 60 * 1000;

async function tick() {
	cleanup.reloadActivity();
	const due = autoRunDue({
		enabled: settings.get<boolean>(AUTO_CLEANUP_ID) === true,
		rulesOn: cleanup.rulesOn,
		hasFolder: workspace.root !== null,
		busy: cleanup.open || cleanup.scanning || cleanup.running,
		lastRunAt: cleanup.lastRunAt,
		now: Date.now()
	});
	if (!due) return;
	try {
		const receipt = await cleanup.runRules('auto');
		const count = receipt.removed.length + receipt.archived.length;
		if (count) status.flash(t('workspaceCleanup.auto.flash', { count }), 8000);
	} catch {
		// A failed scan is already in cleanup.error; the next check tries again.
	}
}

/** Starts the schedule; the returned function stops it. */
export function installAutoCleanup(): () => void {
	const first = setTimeout(() => void tick(), AUTO_FIRST_MS);
	const poll = setInterval(() => void tick(), POLL_MS);
	return () => {
		clearTimeout(first);
		clearInterval(poll);
	};
}
