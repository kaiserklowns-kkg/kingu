// Agent CLIs Kingu installs itself (Rust `agent/managed_cli`), for a machine without the user's
// own: what the chat pane's install card and the Settings row say for a status. Orca's
// `components/managed-runtime/managed-runtime-install-card.ts` (the chat's hero) and
// `managed-runtime-install-view.ts` (Settings › Agents). Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';

export type ManagedPhase = 'downloading' | 'extracting' | 'verifying' | 'removing' | 'succeeded' | 'failed' | 'cancelled';
export type ManagedOperation = { id: number; kind: 'install' | 'remove'; phase: ManagedPhase; downloadedBytes: number; totalBytes: number | null; error?: string };
/** Rust `managed_cli::Status`. */
export type ManagedStatus = {
	agent: string;
	label: string;
	available: boolean;
	version: string | null;
	downloadBytes: number | null;
	downloadHost: string | null;
	installedVersion: string | null;
	installedCurrent: boolean;
	damaged: boolean;
	canRemove: boolean;
	/** What a launch runs now: Kingu's copy, the user's own install, or nothing. */
	source: 'managed' | 'external' | null;
	operation: ManagedOperation | null;
};

const PHASES: readonly ManagedPhase[] = ['downloading', 'extracting', 'verifying', 'removing', 'succeeded', 'failed', 'cancelled'];

/** The Rust answer, checked loosely; null for anything else. */
export function parseStatus(v: unknown): ManagedStatus | null {
	if (!v || typeof v !== 'object') return null;
	const s = v as Record<string, unknown>;
	if (typeof s.agent !== 'string' || typeof s.label !== 'string') return null;
	const str = (x: unknown) => (typeof x === 'string' ? x : null);
	const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
	const o = s.operation && typeof s.operation === 'object' ? (s.operation as Record<string, unknown>) : null;
	const operation: ManagedOperation | null =
		o && typeof o.id === 'number' && (o.kind === 'install' || o.kind === 'remove') && PHASES.includes(o.phase as ManagedPhase)
			? { id: o.id, kind: o.kind, phase: o.phase as ManagedPhase, downloadedBytes: num(o.downloadedBytes) ?? 0, totalBytes: num(o.totalBytes), ...(typeof o.error === 'string' ? { error: o.error } : {}) }
			: null;
	return {
		agent: s.agent,
		label: s.label,
		available: s.available === true,
		version: str(s.version),
		downloadBytes: num(s.downloadBytes),
		downloadHost: str(s.downloadHost),
		installedVersion: str(s.installedVersion),
		installedCurrent: s.installedCurrent === true,
		damaged: s.damaged === true,
		canRemove: s.canRemove === true,
		source: s.source === 'managed' || s.source === 'external' ? s.source : null,
		operation
	};
}

export const parseStatuses = (v: unknown): ManagedStatus[] => (Array.isArray(v) ? v.flatMap((s) => parseStatus(s) ?? []) : []);

export const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

export const isRunning = (s: ManagedStatus | null | undefined): boolean => !!s?.operation && ['downloading', 'extracting', 'verifying', 'removing'].includes(s.operation.phase);

/** Nothing here runs the agent yet: the chat shows the install card instead of starting (Orca: `source === null`). */
export const needsInstall = (s: ManagedStatus | null | undefined): s is ManagedStatus => !!s && s.source === null;

/**
 * Installs that serve another agent's chats (Rust `Managed::serves`): Antigravity's ACP server,
 * which runs the `antigravity` chats Kingu signs in itself (agent/antigravity.rs).
 */
export const SERVES: Readonly<Record<string, string>> = { 'antigravity-server': 'antigravity' };

/** The chat agent an install serves (its icon, its catalog row). */
export const servedAgent = (id: string): string => SERVES[id] ?? id;

/** Rust `antigravity::RouteView`: where a new Antigravity chat runs and what Install adds. */
export type AntigravityRoute = { route: 'agy' | 'server'; installs: string };

export function parseRoute(v: unknown): AntigravityRoute | null {
	if (!v || typeof v !== 'object') return null;
	const r = v as Record<string, unknown>;
	return (r.route === 'agy' || r.route === 'server') && typeof r.installs === 'string' ? { route: r.route, installs: r.installs } : null;
}

/** The install a chat on `runtimeId` needs: Antigravity's follows its route (agy, or Kingu's server). */
export function installFor(list: readonly ManagedStatus[], runtimeId: string, antigravity: AntigravityRoute | null): ManagedStatus | undefined {
	const id = runtimeId === 'antigravity' && antigravity ? antigravity.installs : runtimeId;
	return list.find((s) => s.agent === id);
}

/**
 * The agents the chat's picker offers to install: Kingu can install them here and neither the
 * user's own nor Kingu's copy is there (so the runtime list has none of them). An install that
 * serves another agent's chats is that agent's, never a row of its own.
 */
export function installable(list: readonly ManagedStatus[], runtimeIds: readonly string[]): ManagedStatus[] {
	return list.filter((s) => s.available && needsInstall(s) && !runtimeIds.includes(s.agent) && !Object.hasOwn(SERVES, s.agent));
}

export type ManagedAction = { kind: 'install'; label: string } | { kind: 'cancel'; label: string; operation: number };
export type CardStep = { label: string; state: 'done' | 'current' | 'todo' };
export type InstallCard = {
	tone: 'offer' | 'running' | 'failed' | 'cancelled';
	title: string;
	detail: string | null;
	/** `percent` is null while the size of what remains is unknown. */
	progress: { percent: number | null; detail: string; percentText: string | null } | null;
	steps: CardStep[] | null;
	hint: string | null;
	action: ManagedAction | null;
};

const STEPS: readonly ManagedPhase[] = ['downloading', 'extracting', 'verifying'];

/** Hero fills an empty chat pane; strip sits above the composer of a chat that has messages. */
export type InstallLayout = 'hero' | 'strip';

/** The chat pane's card for a status (Orca `managedRuntimeInstallCard`). */
export function installCard(s: ManagedStatus, cancelling = false, layout: InstallLayout = 'hero'): InstallCard {
	const agent = s.label;
	const op = s.operation;
	const current = op ? STEPS.indexOf(op.phase) : -1;
	if (op && current !== -1) {
		const { downloadedBytes: done, totalBytes: total } = op;
		const percent = current === 0 && total ? Math.min(100, (done / total) * 100) : null;
		const detail =
			current === 1
				? t('managedCli.unpackingDetail')
				: current === 2
					? t('managedCli.checkingDetail', { agent })
					: total === null
						? t('managedCli.downloading', { done: megabytes(done) })
						: t('managedCli.progressOf', { done: megabytes(done), total: megabytes(total) });
		const labels = [t('managedCli.stepDownload'), t('managedCli.stepUnpack'), t('managedCli.stepCheck')];
		return {
			tone: 'running',
			title: cancelling ? t('managedCli.cancelling') : current === 0 ? t('managedCli.downloadingTitle', { agent }) : current === 1 ? t('managedCli.unpackingTitle', { agent }) : t('managedCli.checkingTitle'),
			detail: null,
			progress: { percent, detail, percentText: percent === null ? null : `${Math.round(percent)}%` },
			steps: labels.map((label, i) => ({ label, state: i < current ? 'done' : i === current ? 'current' : 'todo' })),
			hint: null,
			action: { kind: 'cancel', label: cancelling ? t('managedCli.cancelling') : t('managedCli.cancel'), operation: op.id }
		};
	}
	const hero = layout === 'hero';
	const size = s.downloadBytes ? String(Math.ceil(s.downloadBytes / 1_000_000)) : null;
	const sizeHint = hero && size !== null ? t('managedCli.downloadSize', { size }) : null;
	if (op?.kind === 'install' && op.phase === 'cancelled') {
		return { tone: 'cancelled', title: t('managedCli.cancelledTitle'), detail: t('managedCli.cancelledBody'), progress: null, steps: null, hint: sizeHint, action: { kind: 'install', label: t('managedCli.retry') } };
	}
	if (op?.kind === 'install' && op.phase === 'failed') {
		return { tone: 'failed', title: t('managedCli.failedTitle', { agent }), detail: op.error ?? t('managedCli.failed'), progress: null, steps: null, hint: sizeHint, action: { kind: 'install', label: t('managedCli.tryAgain') } };
	}
	if (!s.available) {
		return { tone: 'offer', title: t('managedCli.unavailable', { agent }), detail: null, progress: null, steps: null, hint: null, action: null };
	}
	if (!hero) {
		// One line above the composer: the size and host, then Install; the chat resumes after it.
		const detail = s.damaged ? t('managedCli.damaged', { agent }) : size === null ? null : s.downloadHost ? t('managedCli.stripSizeFrom', { size, host: s.downloadHost }) : t('managedCli.stripSize', { size });
		return { tone: 'offer', title: t('managedCli.continueTitle', { agent }), detail, progress: null, steps: null, hint: null, action: { kind: 'install', label: t('managedCli.installShort') } };
	}
	// What is downloaded and from where is said before anything is.
	const from = s.downloadHost ? t('managedCli.from', { host: s.downloadHost }) : '';
	const body = s.damaged ? t('managedCli.damaged', { agent }) : size === null ? t('managedCli.heroBodyNoSize', { agent }) : t('managedCli.heroBody', { size, agent });
	return {
		tone: 'offer',
		title: t('managedCli.installTitle', { agent }),
		detail: [body, from].filter(Boolean).join(' '),
		progress: null,
		steps: null,
		hint: t('managedCli.settingsHint'),
		action: { kind: 'install', label: t('managedCli.install', { agent }) }
	};
}

export type SettingsView = {
	status: string | null;
	/** What a screen reader hears for the status, when the short visible text leaves out the agent the row sits under. */
	spokenStatus: string | null;
	error: string | null;
	/** Percent downloaded, while a download of known, positive size runs. */
	progress: number | null;
	action: ManagedAction | null;
	/** Kingu's copy can be deleted: one is there and nothing runs. */
	removable: boolean;
	/** A step with no percent runs (unpacking, verifying, removing, a download of unknown size): a spinner shows. */
	busy: boolean;
	/** The status explains a problem (unavailable, damaged, outdated) or counts a download: it wraps whole, never truncates. */
	wraps: boolean;
};

const SETTLED = { spokenStatus: null, busy: false, wraps: false } as const;

/** The Settings › Agents row for a status (Orca `managedRuntimeInstallView`, 4f56f7c0e). */
export function settingsView(s: ManagedStatus, cancelling = false): SettingsView {
	const agent = s.label;
	const op = s.operation;
	if (op?.phase === 'removing') return { ...SETTLED, status: t('managedCli.removing'), error: null, progress: null, action: null, removable: false, busy: true };
	if (op && STEPS.includes(op.phase)) {
		const { downloadedBytes: done, totalBytes: total } = op;
		const verifying = !cancelling && op.phase === 'verifying';
		const extracting = !cancelling && op.phase === 'extracting';
		// Only a known, positive size gives a percent; without one the download spins like the other steps.
		const sized = op.phase === 'downloading' && total !== null && total > 0 ? total : null;
		const status = cancelling
			? t('managedCli.cancelling')
			: extracting
				? t('managedCli.extractingShort')
				: verifying
					? t('managedCli.verifying')
					: sized === null
						? t('managedCli.downloading', { done: megabytes(done) })
						: t('managedCli.downloadingOf', { done: megabytes(done), total: megabytes(sized) });
		return {
			status,
			spokenStatus: verifying ? t('managedCli.verifyingAgent', { agent }) : extracting ? t('managedCli.extracting', { agent }) : null,
			error: null,
			progress: sized === null ? null : Math.min(100, (done / sized) * 100),
			action: { kind: 'cancel', label: t('managedCli.cancel'), operation: op.id },
			removable: false,
			busy: sized === null,
			wraps: !cancelling && op.phase === 'downloading'
		};
	}
	const failed = op?.phase === 'failed';
	const error = failed ? (op.error ?? (op.kind === 'install' ? t('managedCli.failedTitle', { agent }) : t('managedCli.failed'))) : null;
	const view = (status: string | null, label: string | null, reason = false): SettingsView => ({ ...SETTLED, status, error, progress: null, action: label === null ? null : { kind: 'install', label }, removable: s.canRemove, wraps: reason || error !== null });
	// The user's own copy always runs while it exists, so installing Kingu's would change nothing. A
	// failed install of Kingu's copy isn't shown here (the chat card keeps its own Retry); a failed
	// Remove is, since the user asked for it from this row.
	if (s.source === 'external') {
		const shownError = op?.kind === 'install' ? null : error;
		return { ...view(t('managedCli.externalShort'), null), error: shownError, wraps: shownError !== null, spokenStatus: t('managedCli.external', { agent }) };
	}
	if (s.installedVersion !== null) {
		// Kingu keeps its copy on the latest release by itself; Update only shows until it has.
		const outdated = s.available && s.version !== null && !s.installedCurrent;
		return view(t('managedCli.installedByKingu', { version: s.installedVersion }), outdated ? t('managedCli.update') : null, outdated);
	}
	if (!s.available) return view(t('managedCli.unavailable', { agent }), null, true);
	if (s.damaged) return view(t('managedCli.damaged', { agent }), t('managedCli.reinstall'), true);
	if (op?.kind === 'install' && op.phase === 'cancelled') return view(t('managedCli.cancelled'), t('managedCli.tryAgain'));
	if (op?.kind === 'install' && failed) return view(null, t('managedCli.tryAgain'));
	const size = s.downloadBytes ? t('managedCli.downloadSize', { size: String(Math.ceil(s.downloadBytes / 1_000_000)) }) : null;
	// "Not installed" never truncates.
	return view([t('managedCli.notInstalled'), size].filter(Boolean).join(' '), t('managedCli.installShort'), true);
}
