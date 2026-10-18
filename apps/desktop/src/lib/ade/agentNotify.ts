// When to tell the user about an agent while they look elsewhere (Orca's notifications): it needs a
// permission answer, finished a turn and waits for review, or failed. Pure, so `bun test` covers it.

import type { TaskStatus } from './model';

export type Notice = { title: string; body: string };

export function noticeFor(prev: TaskStatus | undefined, next: TaskStatus, task: { title: string; lastEvent?: string }): Notice | null {
	if (prev === undefined || prev === next) return null;
	if (next === 'waiting') return { title: `รอคุณอนุญาต: ${task.title}`, body: task.lastEvent || 'agent ขออนุญาตใช้เครื่องมือ' };
	if (next === 'failed') return { title: `งานล้มเหลว: ${task.title}`, body: task.lastEvent || 'ดูรายละเอียดใน Agents' };
	if (prev === 'running' && next === 'review') return { title: `เสร็จรอบแล้ว: ${task.title}`, body: task.lastEvent || 'รอคุณรีวิว' };
	return null;
}
