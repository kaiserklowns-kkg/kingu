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
import type { RunMode } from './agentCli.ts';
import { defaultBase, defaultRunMode } from './issues.svelte.ts';
import { mergeLinearLists, taskForLinearIssue, type LinearFilter, type LinearIssue, type LinearViewer } from './linear.ts';
import type { IssueLink } from './model.ts';
import { adeTasks } from './tasks.svelte.ts';

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
			notifications.error(`ตรวจการเชื่อมต่อ Linear ไม่ได้: ${e}`);
		}
		return this.viewer;
	}

	/** The dialog's submit: Rust checks the key with Linear before storing it. Throws the reason. */
	async connect(apiKey: string) {
		this.viewer = await invoke<LinearViewer>('linear_connect', { apiKey });
		status.flash(`เชื่อมต่อ Linear แล้ว: ${this.viewer.name} (${this.viewer.organization})`, 6000);
	}

	async disconnect() {
		try {
			await invoke('linear_disconnect');
			this.viewer = null;
			status.flash('ตัดการเชื่อมต่อ Linear แล้ว');
		} catch (e) {
			notifications.error(String(e));
		}
	}

	fetch(filter: LinearFilter, opts: { search?: string; limit?: number } = {}): Promise<LinearIssue[]> {
		return invoke<LinearIssue[]>('linear_issues_list', { filter, team: this.team(), search: opts.search?.trim() || null, limit: opts.limit ?? 50 });
	}

	open(link: Pick<IssueLink, 'url' | 'key'>) {
		return invoke('linear_issue_open', { url: link.url }).catch((e) => notifications.error(`เปิด ${link.key ?? 'issue'} ไม่ได้: ${e}`));
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
		status.flash('กำลังโหลด issues จาก Linear…', 3000);
		let mine: LinearIssue[];
		let all: LinearIssue[];
		try {
			[mine, all] = await Promise.all([this.fetch('assigned'), this.fetch('open', { limit: 100 })]);
		} catch (e) {
			notifications.error(`โหลด issues จาก Linear ไม่ได้: ${e}`);
			return;
		}
		const rows = mergeLinearLists(mine, all);
		if (!rows.length) {
			status.flash(this.team() ? `ไม่มี issue ที่ยังไม่เสร็จในทีม ${this.team()}` : 'ไม่มี issue ที่ยังไม่เสร็จ');
			return;
		}
		const firstOther = rows.findIndex((r) => !r.mine);
		const picked = await quick.choose({
			placeholder: 'เลือก Linear issue ที่จะเริ่มงาน',
			items: rows.map((r, i) => ({
				id: r.issue.id,
				label: `${r.issue.identifier} ${r.issue.title}`,
				description:
					[taskForLinearIssue(adeTasks.list, r.issue.identifier) ? 'มีงานแล้ว' : '', r.issue.state, r.issue.priority ? r.issue.priority_label : '', ...r.issue.labels.map((l) => l.name)]
						.filter(Boolean)
						.join(' · ') || undefined,
				separator: i === 0 && r.mine ? 'มอบหมายให้ฉัน' : i === firstOther ? 'issue ที่ยังไม่เสร็จทั้งหมด' : undefined
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
			placeholder: `แตกจาก branch ไหน (งาน ${issue.identifier})`,
			items: branches.map((b) => ({ id: b, label: b || 'HEAD', description: b === current ? 'branch ปัจจุบัน' : undefined }))
		});
		if (!base) return;
		const preferred = defaultRunMode();
		const modes: { id: RunMode; label: string }[] = [
			{ id: 'terminal', label: `Terminal · ${settings.get<string>('kingu.agent.cli') || 'claude'}` },
			{ id: 'timeline', label: 'Timeline' }
		];
		const mode = await quick.choose({
			placeholder: 'วิธีรัน agent',
			items: [...modes].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
		});
		if (!mode) return;
		await adeTasks.createFromLinearIssue(issue, { base: base.id, mode: mode.id as RunMode });
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
				if (await quick.choose({ placeholder: 'ลบ Linear API key ออกจาก Keychain?', items: [{ id: 'yes', label: 'ตัดการเชื่อมต่อ' }] })) await linear.disconnect();
			}
		})
	];
	return () => unregister.forEach((u) => u());
}
