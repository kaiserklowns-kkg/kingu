// Org administration: the shapes of /v1/members, /v1/tokens and /v1/audit, and the
// role rules the server enforces (the pages only hide what the server would refuse).

export type Role = 'owner' | 'lead' | 'dev' | 'viewer';
export const ROLES: Role[] = ['owner', 'lead', 'dev', 'viewer'];

export const ROLE_LABEL: Record<Role, string> = {
	owner: 'Owner',
	lead: 'Lead',
	dev: 'Dev',
	viewer: 'Viewer'
};

export const ROLE_HINT: Record<Role, string> = {
	owner: 'จัดการทุกอย่าง รวมถึงสมาชิก token ของคนอื่น และชื่อทีม',
	lead: 'สร้างโปรเจกต์ อนุมัติ snap ดู audit log จัดการสมาชิก dev/viewer',
	dev: 'ซิงก์งานและการรัน แชร์ artifact และ skill',
	viewer: 'ดูอย่างเดียว (สร้าง/เพิกถอน token ของตัวเองได้)'
};

export type Member = { user_id: string; role: Role; created_at: string; active_tokens: number };

export type Token = {
	id: string;
	user_id: string;
	name: string;
	prefix: string;
	created_at: string;
	last_used_at: string | null;
	expires_at: string | null;
	revoked_at: string | null;
	/** The token this dashboard session signed in with. */
	current: boolean;
};

export type MintedToken = { id: string; token: string; prefix: string; user_id: string; role: Role; expires_at: string | null; name: string };

export type AuditEntry = {
	id: number;
	actor: string;
	action: string;
	target_type: string;
	target_id: string | null;
	details: Record<string, unknown>;
	created_at: string;
};

export type Page<T> = { items: T[]; next_cursor: string | null };

export const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as string[]).includes(r);
export const isAdmin = (role: string | undefined) => role === 'owner' || role === 'lead';

const low = (r: Role | null) => r === null || r === 'dev' || r === 'viewer';

/**
 * Whether `me` may move a member from `from` to `to` (null = not a member / removed).
 * Owners manage anyone; leads only dev and viewer members.
 */
export function canManage(me: string | undefined, from: Role | null, to: Role | null): boolean {
	if (me === 'owner') return true;
	return me === 'lead' && low(from) && low(to);
}

/** Roles `me` may give a member whose role is now `from`. */
export function assignableRoles(me: string | undefined, from: Role | null): Role[] {
	return ROLES.filter((r) => canManage(me, from, r));
}

export type TokenState = 'active' | 'expired' | 'revoked';

export function tokenState(t: Pick<Token, 'expires_at' | 'revoked_at'>, now: number = Date.now()): TokenState {
	if (t.revoked_at) return 'revoked';
	if (t.expires_at && Date.parse(t.expires_at) <= now) return 'expired';
	return 'active';
}

export const TOKEN_STATE_LABEL: Record<TokenState, string> = { active: 'ใช้งานได้', expired: 'หมดอายุ', revoked: 'เพิกถอนแล้ว' };

/** Lifetimes offered when creating a token, in hours (0 = never expires). */
export const TOKEN_TTLS: { hours: number; label: string }[] = [
	{ hours: 24 * 30, label: '30 วัน' },
	{ hours: 24 * 90, label: '90 วัน' },
	{ hours: 24 * 365, label: '1 ปี' },
	{ hours: 0, label: 'ไม่หมดอายุ' }
];

export function parseTTL(v: unknown): number | null {
	// Number(null) and Number('') are 0 ("never expires"): a missing field must not mean that.
	if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
	const n = Number(v);
	return TOKEN_TTLS.some((t) => t.hours === n) ? n : null;
}

/** user_id rules of the server: 1-255 characters, not blank, no control characters. */
export function validUserId(v: string): boolean {
	// eslint-disable-next-line no-control-regex
	return v.trim() !== '' && [...v].length <= 255 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
}

const ACTION_LABEL: Record<string, string> = {
	'project.create': 'สร้างโปรเจกต์',
	'task.create': 'สร้างงาน',
	'task.update': 'แก้ไขงาน',
	'task.sync': 'ซิงก์งาน',
	'run.create': 'บันทึกการรัน',
	'run.sync': 'ซิงก์การรัน',
	'run.close': 'ปิดการรัน',
	'token.create': 'สร้าง token',
	'token.revoke': 'เพิกถอน token',
	'member.add': 'เพิ่มสมาชิก',
	'member.role': 'เปลี่ยนบทบาท',
	'member.remove': 'นำสมาชิกออก',
	'org.rename': 'เปลี่ยนชื่อทีม',
	'snap.approve': 'อนุมัติ snap',
	'snap.remove': 'ถอน snap',
	'snap.publish': 'เผยแพร่ snap',
	'snap.yank': 'yank snap',
	'snap.unyank': 'ยกเลิก yank snap',
	'artifact.share': 'แชร์ artifact',
	'artifact.remove': 'เลิกแชร์ artifact',
	'skill.share': 'แชร์ skill',
	'skill.unshare': 'เลิกแชร์ skill'
};

export const actionLabel = (a: string) => ACTION_LABEL[a] ?? a;

/** Filter choices for the audit page: `?action=` prefixes the server understands. */
export const AUDIT_GROUPS: { value: string; label: string }[] = [
	{ value: '', label: 'ทั้งหมด' },
	{ value: 'member.', label: 'สมาชิก' },
	{ value: 'token.', label: 'Token' },
	{ value: 'org.', label: 'ทีม' },
	{ value: 'project.', label: 'โปรเจกต์' },
	{ value: 'task.', label: 'งาน' },
	{ value: 'run.', label: 'การรัน' },
	{ value: 'snap.', label: 'Snap' },
	{ value: 'artifact.', label: 'Artifact' },
	{ value: 'skill.', label: 'Skill' }
];

/** One-line summary of an audit entry's details (metadata only, never secrets). */
export function auditSummary(e: AuditEntry): string {
	const d = e.details ?? {};
	const s = (k: string) => (typeof d[k] === 'string' || typeof d[k] === 'number' ? String(d[k]) : null);
	switch (e.action) {
		case 'member.add':
			return `${s('user_id')} เป็น ${s('role')}`;
		case 'member.role':
			return `${s('user_id')}: ${s('old_role')} → ${s('role')}`;
		case 'member.remove':
			return `${s('user_id')} (${s('role')})`;
		case 'token.create':
		case 'token.revoke':
			return [s('prefix'), s('name') ? `“${s('name')}”` : null, s('user_id') ? `ของ ${s('user_id')}` : null].filter(Boolean).join(' ');
		case 'org.rename':
			return `${s('old_name')} → ${s('name')}`;
	}
	return Object.entries(d)
		.filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
		.slice(0, 4)
		.map(([k, v]) => `${k}=${v}`)
		.join(' · ');
}

export type ProjectInfo = {
	id: string;
	name: string;
	repo_url: string;
	default_base_ref: string;
	created_at: string;
	updated_at: string;
	task_count: number;
};

/** Mirrors the server's repo URL rule closely enough to catch typos before the round trip. */
export function plausibleRepoUrl(v: string): boolean {
	if (v.length < 1 || v.length > 2048 || /\s/.test(v)) return false;
	if (/^[\w.-]+@[\w.-]+:\S+$/.test(v)) return true; // git@host:org/repo.git
	try {
		const u = new URL(v);
		return (u.protocol === 'https:' || u.protocol === 'ssh:') && !u.password && !!u.hostname;
	} catch {
		return false;
	}
}
