// Automations (Orca-style): agent tasks that start on a schedule while Kingu runs. The list lives in
// `<root>/.kingu/automations.json` (Rust validates and writes it); `decide` (automations.ts) picks
// what is due, and a run is an ordinary task (`adeTasks.create`), so it gets a worktree, its agent,
// notifications and team sync like any other. Safety: each automation is off until the user
// enables it (a native confirm), that consent is remembered on this machine only (a repository can
// ship an enabled automations.json), and `kingu.automations.enabled` stops them all.

import { invoke } from '@tauri-apps/api/core';
import { ask } from '#lib/workbench/messageBox.ts';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { untrack } from 'svelte';
import { adeLayout } from './adeLayout.svelte.ts';
import { notify } from './agentNotify.svelte.ts';
import type { RunMode } from './agentCli.ts';
import { consentKey, decide, formatWhen, newAutomation, nextRunOf, runTitle, type Automation, type Decision } from './automations.ts';
import { uniqueSlug } from './model.ts';
import { parseSchedule, upcoming } from './schedule.ts';
import { adeTasks } from './tasks.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';

const CONSENT_STORE = 'kingu.automations.consent';
const TICK_MS = 30_000;
/** After a folder loads, wait for restored agent CLIs to report before judging "still working". */
const SETTLE_MS = 10_000;

export type AutomationInput = { name: string; prompt: string; schedule: string; base: string | null; mode: RunMode | null; catch_up: boolean };

function readConsent(): Record<string, string> {
	try {
		const v = JSON.parse(localStorage.getItem(CONSENT_STORE) ?? '{}');
		return v && typeof v === 'object' ? v : {};
	} catch {
		return {};
	}
}

const isWorking = (slug: string) => {
	const s = adeTasks.find(slug)?.status;
	return s === 'running' || s === 'waiting';
};

class AdeAutomations {
	list = $state<Automation[]>([]);
	loaded = $state(false);
	/** Ticks with the runner so "next run" labels move. */
	now = $state(Date.now());
	/** The editor form: a new automation (`id: null`) or the one being edited. */
	editing = $state<{ id: string | null } | null>(null);
	globalEnabled = $derived(settings.get<boolean>('kingu.automations.enabled') !== false);
	/** Enabled and confirmed on this machine. */
	activeCount = $derived(this.list.filter((a) => this.isActive(a)).length);

	#consent = $state<Record<string, string>>(readConsent());
	#root: string | null = null;
	#saving: Promise<void> = Promise.resolve();
	/** Due times handled this session, ahead of the save (never run a window twice). */
	#handled: Record<string, number> = {};
	#readyAt = 0;
	#ticking = false;

	#consentId(id: string) {
		return `${this.#root}\n${id}`;
	}

	/** The user confirmed exactly this automation (prompt, schedule, base, mode) on this machine. */
	consented(a: Automation): boolean {
		return !!this.#root && this.#consent[this.#consentId(a.id)] === consentKey(this.#root, a);
	}

	isActive(a: Automation): boolean {
		return a.enabled && this.consented(a);
	}

	nextRun(a: Automation): number | null {
		return this.isActive(a) ? nextRunOf(a, this.now, this.#handled[a.id]) : null;
	}

	find(id: string): Automation | undefined {
		return this.list.find((a) => a.id === id);
	}

	#setConsent(a: Automation | null, id: string) {
		const next = { ...this.#consent };
		if (a && this.#root) next[this.#consentId(id)] = consentKey(this.#root, a);
		else delete next[this.#consentId(id)];
		this.#consent = next;
		try {
			localStorage.setItem(CONSENT_STORE, JSON.stringify(next));
		} catch {
			// Without storage the consent lasts this session only.
		}
	}

	async load() {
		const root = workspace.root;
		this.#root = root;
		this.list = [];
		this.loaded = false;
		this.#handled = {};
		this.#readyAt = Date.now() + SETTLE_MS;
		if (!root) return;
		try {
			const list = await invoke<Automation[]>('automations_load');
			if (this.#root !== root) return;
			this.list = list;
		} catch (e) {
			notifications.error(`โหลด automations ไม่ได้: ${e}`);
			clientLog('error', `automations_load: ${e}`);
		}
		this.loaded = true;
	}

	#save(next: Automation[]): Promise<void> {
		const now = Date.now();
		this.list = next.map((a) => ({ ...a, next_run_at: this.isActive(a) ? nextRunOf(a, now, this.#handled[a.id]) : null }));
		const snapshot = $state.snapshot(this.list) as Automation[];
		const root = this.#root;
		this.#saving = this.#saving.then(() => {
			if (root !== workspace.root) return;
			return invoke<void>('automations_save', { automations: snapshot }).catch((e) => {
				notifications.error(`บันทึก automations.json ไม่ได้: ${e}`);
				clientLog('error', `automations_save: ${e}`);
			});
		});
		return this.#saving;
	}

	#patch(id: string, patch: Partial<Automation>) {
		return this.#save(this.list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
	}

	/** Native confirm before an automation may spend tokens on its own. */
	async #confirmEnable(a: Automation): Promise<boolean> {
		const now = Date.now();
		const next = upcoming(a.schedule, now, now);
		const mode = a.mode ?? (settings.get<string>('kingu.agent.runMode') === 'timeline' ? 'timeline' : 'terminal');
		return ask(
			`เปิด automation "${a.name}"?\n\nตารางเวลา: ${a.schedule}\nรอบถัดไป: ${formatWhen(next, now)}\nแตกจาก: ${a.base ?? 'branch ปัจจุบันของโฟลเดอร์'} · โหมด: ${mode}\n\nทุกรอบจะสร้าง worktree และเริ่ม agent เองขณะ Kingu เปิดอยู่ ซึ่งใช้ token`,
			{ title: 'เปิด Automation', kind: 'warning', okLabel: 'เปิดใช้', cancelLabel: 'ยกเลิก' }
		);
	}

	validate(input: AutomationInput): string | null {
		if (!input.name.trim()) return 'ใส่ชื่อ automation';
		if (input.name.trim().length > 100) return 'ชื่อยาวได้ไม่เกิน 100 ตัวอักษร';
		if (!input.prompt.trim()) return 'ใส่คำสั่งให้ agent';
		const parsed = parseSchedule(input.schedule);
		return parsed.ok ? null : parsed.error;
	}

	/** Saves a new automation (always off) or an edit; an enabled one whose run changes asks again. */
	async save(id: string | null, input: AutomationInput): Promise<boolean> {
		const error = this.validate(input);
		if (error) {
			status.flash(error, 8000);
			return false;
		}
		const now = Date.now();
		if (id === null) {
			const taken = new Set(this.list.map((a) => a.id));
			const a = newAutomation({ ...input, id: uniqueSlug(`auto-${input.name}`, taken) }, now);
			await this.#save([...this.list, a]);
			status.flash(`สร้าง automation "${a.name}" แล้ว (ยังปิดอยู่ — เปิดเมื่อพร้อม)`, 6000);
			return true;
		}
		const old = this.find(id);
		if (!old) return false;
		const next: Automation = { ...old, name: input.name.trim(), prompt: input.prompt.trim(), schedule: input.schedule.trim(), base: input.base || null, mode: input.mode, catch_up: input.catch_up };
		if (next.enabled && this.#root && consentKey(this.#root, next) !== consentKey(this.#root, old)) {
			if (await this.#confirmEnable(next)) {
				this.#setConsent(next, id);
				next.enabled_at = now;
			} else {
				next.enabled = false;
				status.flash(`บันทึกแล้ว แต่ปิด "${next.name}" ไว้จนกว่าจะยืนยัน`, 6000);
			}
		}
		await this.#save(this.list.map((a) => (a.id === id ? next : a)));
		return true;
	}

	/** Enabling asks once (showing name, schedule and next run); due times before it never run. */
	async setEnabled(id: string, on: boolean) {
		const a = this.find(id);
		if (!a) return;
		if (!on) {
			await this.#patch(id, { enabled: false });
			return;
		}
		if (!(await this.#confirmEnable(a))) return;
		this.#setConsent(a, id);
		await this.#patch(id, { enabled: true, enabled_at: Date.now() });
		if (!this.globalEnabled) status.flash('automation เปิดแล้ว แต่ Automations ทั้งหมดถูกหยุดอยู่ (kingu.automations.enabled)', 8000);
	}

	async remove(id: string) {
		const a = this.find(id);
		if (!a) return;
		if (!(await ask(`ลบ automation "${a.name}"?\n\nงานที่เคยสร้างไว้ยังอยู่`, { title: 'ลบ Automation', kind: 'warning', okLabel: 'ลบ', cancelLabel: 'ยกเลิก' }))) return;
		this.#setConsent(null, id);
		delete this.#handled[id];
		if (this.editing?.id === id) this.editing = null;
		await this.#save(this.list.filter((x) => x.id !== id));
	}

	/** Starts a run right away (the user asked: no schedule, switch or enabled check). */
	async runNow(id: string) {
		const a = this.find(id);
		if (!a) return;
		if (a.last_task_slug && isWorking(a.last_task_slug)) {
			const ok = await ask(`งานรอบก่อน (kingu/${a.last_task_slug}) ยังทำงานอยู่\n\nเริ่มอีกรอบเลยไหม?`, { title: 'Run Now', okLabel: 'เริ่ม', cancelLabel: 'ยกเลิก' });
			if (!ok) return;
		}
		await this.#start(a, null);
	}

	/** Creates the task like the composer does; `due` null = Run now (it keeps the schedule's window). */
	async #start(a: Automation, due: number | null) {
		const now = Date.now();
		const slug = await adeTasks.create({ title: runTitle(a.name, new Date(due ?? now)), prompt: a.prompt, base: a.base ?? '', mode: a.mode ?? undefined, open: false, slugHint: a.id });
		if (!slug) {
			await this.#patch(a.id, { last_skip: { at: now, reason: 'สร้างงานไม่สำเร็จ (ดูข้อความใน status bar)' } });
			return;
		}
		await this.#patch(a.id, { last_run_at: now, last_task_slug: slug, last_skip: null });
		clientLog('info', `automation ${a.id} started task ${slug}`);
		status.flash(`Automation เริ่มงาน: ${a.name} → ${adeTasks.branchOf(slug)}`, 8000);
		if (settings.get<boolean>('kingu.agent.notifications') !== false) void notify(`Automation เริ่มงาน: ${a.name}`, adeTasks.branchOf(slug));
	}

	/** The runner: what is due now, re-checked against the file so another window cannot double it. */
	async tick() {
		this.now = Date.now();
		const root = this.#root;
		if (this.#ticking || !this.loaded || !adeTasks.loaded || !root || root !== workspace.root || Date.now() < this.#readyAt) return;
		const active = (list: Automation[]) => list.map((a) => ({ ...a, enabled: this.isActive(a) }));
		if (!decide(active(this.list), this.now, this.#handled, isWorking, this.globalEnabled).length) return;
		this.#ticking = true;
		try {
			const fresh = await invoke<Automation[]>('automations_load');
			if (root !== workspace.root) return;
			this.list = fresh;
			const decisions = decide(active(fresh), Date.now(), this.#handled, isWorking, this.globalEnabled);
			// Claim each window in the file before starting anything.
			for (const d of decisions) this.#handled[d.id] = d.due;
			const at = Date.now();
			const handle = (a: Automation, d: Decision): Automation =>
				d.action === 'skip' ? { ...a, last_due_at: d.due, last_skip: { at, reason: d.reason } } : { ...a, last_due_at: d.due };
			await this.#save(fresh.map((a) => {
				const d = decisions.find((x) => x.id === a.id);
				return d ? handle(a, d) : a;
			}));
			for (const d of decisions) {
				const a = this.find(d.id);
				if (!a) continue;
				if (d.action === 'skip') clientLog('info', `automation ${a.id} skipped: ${d.reason}`);
				else await this.#start(a, d.due);
			}
		} catch (e) {
			clientLog('error', `automations tick: ${e}`);
		} finally {
			this.#ticking = false;
		}
	}

	/** Palette "Pause All": turns the global switch off (user settings), every folder. */
	async pauseAll() {
		try {
			await settings.set('kingu.automations.enabled', false, 'user');
			status.flash('หยุด Automations ทั้งหมดแล้ว — เปิดอีกครั้งได้ที่หน้า Automations หรือ Settings', 8000);
		} catch (e) {
			notifications.error(`หยุด Automations ไม่ได้: ${e}`);
		}
	}

	async resumeAll() {
		try {
			await settings.set('kingu.automations.enabled', undefined, 'user');
		} catch (e) {
			notifications.error(`เปิด Automations ไม่ได้: ${e}`);
		}
	}

	/** The Automations page in the Agents layout (switches to it from the editor). */
	openPage(editing?: { id: string | null }) {
		if (!appMode.isAgents) appMode.setMode('agents');
		appMode.sessionsVisible = true;
		adeLayout.page = 'automations';
		if (editing) this.editing = editing;
	}

	pickAndRun() {
		quick.pick({
			placeholder: 'เลือก automation ที่จะเริ่มตอนนี้',
			items: this.list.map((a) => ({ id: a.id, label: a.name, description: `${a.schedule}${this.isActive(a) ? '' : ' · ปิดอยู่'}` })),
			onAccept: (item) => void this.runNow(item.id)
		});
	}
}

export const automations = new AdeAutomations();

/** Workbench wiring: loads automations per folder, runs the timer, registers palette commands. */
export function installAutomations(): () => void {
	const stopEffects = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(() => {
				automations.editing = null;
				void automations.load();
			});
		});
	});
	const timer = setInterval(() => void automations.tick(), TICK_MS);
	const hasRoot = () => workspace.root !== null;
	const unregister = [
		commands.register({ id: 'kingu.automations.new', title: 'Automations: New…', category: 'Agents', when: hasRoot, run: () => automations.openPage({ id: null }) }),
		commands.register({ id: 'kingu.automations.runNow', title: 'Automations: Run Now…', category: 'Agents', when: () => automations.list.length > 0, run: () => automations.pickAndRun() }),
		commands.register({ id: 'kingu.automations.pauseAll', title: 'Automations: Pause All', category: 'Agents', when: () => automations.globalEnabled, run: () => automations.pauseAll() }),
		commands.register({ id: 'kingu.automations.show', title: 'Automations: Show', category: 'Agents', when: hasRoot, run: () => automations.openPage() })
	];
	return () => {
		stopEffects();
		clearInterval(timer);
		unregister.forEach((u) => u());
	};
}
