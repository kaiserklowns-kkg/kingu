// Turns a team server error into a form failure with a Thai message.

import { fail } from '@sveltejs/kit';
import { ApiError } from './api.ts';

const BY_CODE: Record<string, string> = {
	forbidden: 'บทบาทของคุณทำรายการนี้ไม่ได้',
	last_owner: 'ทีมต้องมี owner อย่างน้อยหนึ่งคน',
	too_many_tokens: 'สมาชิกคนนี้มี token ที่ใช้งานได้ครบ 50 อันแล้ว เพิกถอนอันเก่าก่อน',
	run_closed: 'การรันนี้จบไปแล้ว',
	rate_limited: 'ส่งคำขอถี่เกินไป ลองใหม่อีกครั้งในอีกสักครู่',
	unreachable: 'ติดต่อเซิร์ฟเวอร์ทีมไม่ได้'
};

export function apiFail(e: unknown, notFound = 'ไม่พบรายการนี้ (อาจถูกลบไปแล้ว)') {
	if (!(e instanceof ApiError)) throw e;
	if (e.status === 404) return fail(404, { error: notFound });
	const msg = BY_CODE[e.code] ?? (e.status === 400 ? `ข้อมูลไม่ถูกต้อง: ${e.message}` : 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง');
	return fail(e.status >= 400 && e.status < 600 ? e.status : 502, { error: msg });
}
