// Linear tasks (Orca's Linear integration): connect with a personal API key (kept in the
// Keychain by Rust `linear.rs`, never here), then "Linear: Start Task from Issue…" picks an
// unfinished issue (assigned to me first), the base branch and the run mode, and starts a task
// whose branch carries the identifier so Linear links the PR. `kingu.linear.team` narrows the
// lists to one team key.

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { defaultBase } from './issues.svelte.ts';
import { mergeLinearLists, taskForLinearIssue, type LinearFilter, type LinearIssue, type LinearViewer } from './linear.ts';
import type { IssueLink } from './model.ts';
import { adeTasks } from './tasks.svelte.ts';
import { t } from '#lib/i18n/index.ts';

class AdeLinear {
	/** Whoever the stored key belongs to; null when not connected or not checked yet. */
	viewer = $state<LinearViewer | null>(null);
	/** The Connect dialog is open. */
	connecting = $state(false);

	team = () => settings.get<string>('kingu.linear.team')?.trim() || null;

	async refresh(): Promise<LinearViewer | null> {
		try {
			this.viewer = await invoke<LinearViewer | null>('linear_status');
		} catch (e) {
			notifications.error(t('adeTasks.linear.checkFailed', { error: String(e) }));
		}
		return this.viewer;
	}

	/** The dialog's submit: Rust checks the key with Linear before storing it. Throws the reason. */
	async connect(apiKey: string) {
		this.viewer = await invoke<LinearViewer>('linear_connect', { apiKey });
		status.flash(t('adeTasks.linear.connected', { name: this.viewer.name, organization: this.viewer.organization }), 6000);
	}

	async disconnect() {
		try {
			await invoke('linear_disconnect');
			this.viewer = null;
			status.flash(t('adeTasks.linear.disconnected'));
		} catch (e) {
			notifications.error(String(e));
		}
	}

	fetch(filter: LinearFilter, opts: { search?: string; limit?: number } = {}): Promise<LinearIssue[]> {
		return invoke<LinearIssue[]>('linear_issues_list', { filter, team: this.team(), search: opts.search?.trim() || null, limit: opts.limit ?? 50 });
	}

	open(link: Pick<IssueLink, 'url' | 'key'>) {
		return invoke('linear_issue_open', { url: link.url }).catch((e) => notifications.error(t('adeTasks.issues.openFailed', { ref: link.key ?? 'issue', error: String(e) })));
	}

	/** Connected, or opens the Connect dialog and says so. */
	async #ready(): Promise<boolean> {
		if (this.viewer || (await this.refresh())) return true;
		this.connecting = true;
		return false;
	}

	/** Palette: an unfinished issue (assigned to me first), then the base branch and run mode, then the task. */
	async pickAndStart() {
		if (!(await this.#ready())) return;
		status.flash(t('adeTasks.linear.loading'), 3000);
		let mine: LinearIssue[];
		let all: LinearIssue[];
		try {
			[mine, all] = await Promise.all([this.fetch('assigned'), this.fetch('open', { limit: 100 })]);
		} catch (e) {
			notifications.error(t('adeTasks.linear.loadFailed', { error: String(e) }));
			return;
		}
		const rows = mergeLinearLists(mine, all);
		if (!rows.length) {
			const team = this.team();
			status.flash(team ? t('adeTasks.linear.noneInTeam', { team }) : t('adeTasks.linear.none'));
			return;
		}
		const firstOther = rows.findIndex((r) => !r.mine);
		const picked = await quick.choose({
			placeholder: t('adeTasks.linear.pickPlaceholder'),
			items: rows.map((r, i) => ({
				id: r.issue.id,
				label: `${r.issue.identifier} ${r.issue.title}`,
				description:
					[taskForLinearIssue(adeTasks.list, r.issue.identifier) ? t('adeTasks.issues.hasTask') : '', r.issue.state, r.issue.priority ? r.issue.priority_label : '', ...r.issue.labels.map((l) => l.name)]
						.filter(Boolean)
						.join(' · ') || undefined,
				separator: i === 0 && r.mine ? t('adeTasks.issues.assignedToMe') : i === firstOther ? t('adeTasks.linear.allUnfinished') : undefined
			}))
		});
		const issue = picked && rows.find((r) => r.issue.id === picked.id)?.issue;
		if (!issue) return;
		if (taskForLinearIssue(adeTasks.list, issue.identifier)) {
			// createFromLinearIssue asks whether to open it.
			await adeTasks.createFromLinearIssue(issue, { base: defaultBase() });
			return;
		}
		await adeTasks.refreshBranches();
		const current = defaultBase();
		const branches = adeTasks.branches.length ? [current, ...adeTasks.branches.filter((b) => b !== current)] : [''];
		const base = await quick.choose({
			placeholder: t('adeTasks.issues.basePlaceholder', { ref: issue.identifier }),
			items: branches.map((b) => ({ id: b, label: b || 'HEAD', description: b === current ? t('adeTasks.issues.currentBranch') : undefined }))
		});
		if (!base) return;
		await adeTasks.createFromLinearIssue(issue, { base: base.id, mode: 'terminal' });
	}
}

export const linear = new AdeLinear();

/** Workbench wiring: the palette commands. */
export function installLinear(): () => void {
	const hasRoot = () => workspace.root !== null;
	const unregister = [
		commands.register({ id: 'kingu.linear.startTask', title: 'Linear: Start Task from Issue…', category: 'Agents', when: hasRoot, run: () => linear.pickAndStart() }),
		commands.register({ id: 'kingu.linear.connect', title: 'Linear: Connect…', category: 'Agents', run: () => void (linear.connecting = true) }),
		commands.register({
			id: 'kingu.linear.disconnect',
			title: 'Linear: Disconnect',
			category: 'Agents',
			run: async () => {
				if (await quick.choose({ placeholder: t('adeTasks.linear.disconnectAsk'), items: [{ id: 'yes', label: t('adeTasks.linear.disconnect') }] })) await linear.disconnect();
			}
		})
	];
	return () => unregister.forEach((u) => u());
}
