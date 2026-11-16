// Workspace Space (Orca's workspaceSpace view): the shapes Rust's workspace_space.rs returns and the
// formatting the dialog uses. Pure, so it is tested without Tauri.

export type SpaceItem = { name: string; path: string; kind: 'directory' | 'file' | 'other'; sizeBytes: number };

export type SpaceRow = {
	path: string;
	branch: string | null;
	slug: string | null;
	isMain: boolean;
	status: 'ok' | 'missing' | 'permission-denied' | 'error';
	error: string | null;
	sizeBytes: number;
	reclaimableBytes: number;
	topItems: SpaceItem[];
	omittedItemCount: number;
	omittedBytes: number;
};

export type SpaceAnalysis = {
	scannedAt: number;
	totalBytes: number;
	reclaimableBytes: number;
	worktreeCount: number;
	scannedCount: number;
	unavailableCount: number;
	rows: SpaceRow[];
};

export type SpaceProgress = { scanned: number; total: number; current: string | null };

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1024-based sizes: `0 B`, `812 KB`, `1.4 GB` (one decimal under 10, none above). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	let n = bytes;
	let unit = 0;
	while (n >= 1024 && unit < UNITS.length - 1) {
		n /= 1024;
		unit++;
	}
	const text = unit === 0 || n >= 10 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString();
	return `${text} ${UNITS[unit]}`;
}

/** Share of `part` in `whole` as a 0–100 bar width; a non-zero part never shows as empty. */
export function share(part: number, whole: number): number {
	if (whole <= 0 || part <= 0) return 0;
	return Math.max(1, Math.min(100, (part / whole) * 100));
}

/** What a row is called: its task, else its branch, else its folder name. */
export function rowLabel(row: Pick<SpaceRow, 'slug' | 'branch' | 'path' | 'isMain'>): string {
	if (row.slug) return row.slug;
	if (row.branch) return row.branch;
	return row.path.split('/').filter(Boolean).pop() ?? row.path;
}

export const STATUS_TEXT: Record<SpaceRow['status'], string> = {
	ok: '',
	missing: 'Folder missing',
	'permission-denied': 'No permission',
	error: "Couldn't measure"
};

/** Progress bar text: `Measuring 3 of 7 · fix-login`. */
export function progressText(p: SpaceProgress | null): string {
	if (!p || p.total === 0) return 'Listing workspaces…';
	const at = Math.min(p.scanned + 1, p.total);
	return `Measuring ${at} of ${p.total}${p.current ? ` · ${p.current}` : ''}`;
}
