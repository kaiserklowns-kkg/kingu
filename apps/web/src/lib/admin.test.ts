/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { assignableRoles, auditSummary, canManage, parseTTL, tokenState, validUserId, type AuditEntry } from './admin';

describe('member role rules (mirror the server)', () => {
	test('owners manage anyone', () => {
		expect(assignableRoles('owner', 'owner')).toEqual(['owner', 'lead', 'dev', 'viewer']);
		expect(canManage('owner', 'owner', null)).toBe(true);
	});
	test('leads manage only dev and viewer members', () => {
		expect(assignableRoles('lead', null)).toEqual(['dev', 'viewer']);
		expect(assignableRoles('lead', 'dev')).toEqual(['dev', 'viewer']);
		expect(assignableRoles('lead', 'lead')).toEqual([]);
		expect(canManage('lead', 'viewer', null)).toBe(true);
		expect(canManage('lead', 'owner', null)).toBe(false);
	});
	test('devs and viewers manage nobody', () => {
		for (const me of ['dev', 'viewer', undefined]) {
			expect(assignableRoles(me, null)).toEqual([]);
			expect(canManage(me, 'viewer', null)).toBe(false);
		}
	});
});

describe('tokenState', () => {
	const now = Date.parse('2026-11-20T00:00:00Z');
	test('revoked wins over expiry', () => {
		expect(tokenState({ revoked_at: '2026-11-01T00:00:00Z', expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('revoked');
	});
	test('expired at or after expires_at', () => {
		expect(tokenState({ revoked_at: null, expires_at: '2026-11-20T00:00:00Z' }, now)).toBe('expired');
		expect(tokenState({ revoked_at: null, expires_at: '2026-11-21T00:00:00Z' }, now)).toBe('active');
		expect(tokenState({ revoked_at: null, expires_at: null }, now)).toBe('active');
	});
});

test('parseTTL accepts only the offered lifetimes', () => {
	expect(parseTTL('2160')).toBe(2160);
	expect(parseTTL('0')).toBe(0);
	expect(parseTTL('5')).toBeNull();
	expect(parseTTL(null)).toBeNull();
});

test('validUserId', () => {
	expect(validUserId('alice@example.com')).toBe(true);
	expect(validUserId('  ')).toBe(false);
	expect(validUserId('a\nb')).toBe(false);
	expect(validUserId('x'.repeat(256))).toBe(false);
});

describe('auditSummary', () => {
	const e = (action: string, details: Record<string, unknown>): AuditEntry => ({
		id: 1,
		actor: 'olivia',
		action,
		target_type: 'member',
		target_id: null,
		details,
		created_at: '2026-11-20T00:00:00Z'
	});
	test('member and token actions read naturally', () => {
		expect(auditSummary(e('member.role', { user_id: 'dana', role: 'lead', old_role: 'dev' }))).toBe('dana: dev → lead');
		expect(auditSummary(e('token.revoke', { prefix: 'kgu_AbCd1234', name: 'ci', user_id: 'vic' }))).toBe('kgu_AbCd1234 “ci” ของ vic');
		expect(auditSummary(e('token.create', { prefix: 'kgu_AbCd1234', name: '' }))).toBe('kgu_AbCd1234');
	});
	test('other actions list scalar details only', () => {
		expect(auditSummary(e('task.update', { status: 'done', nested: { a: 1 } }))).toBe('status=done');
	});
});
