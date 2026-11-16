// Orca 1.4.259's Workspace Cleanup rules as settings (Settings › Workspace Cleanup). The shapes and
// the off-by-default values are ade/workspaceCleanupPolicy.ts (ported from Orca); this file only
// registers them. Both settings can delete worktrees, so neither is ever read from a repository's
// own `.kingu/settings.json`: the global rules are user-only, a project's override is yours (user
// settings or Kingu's per-repository store).
import type { SettingSchema } from '../registry';
import type { JsonSchema } from '../jsonSchema';
import { getDefaultWorkspaceCleanupRules, WORKSPACE_CLEANUP_INACTIVE_ACTIONS, WORKSPACE_CLEANUP_KEEP_WHEN_VALUES, WORKSPACE_CLEANUP_POLICY_MAX_DAYS, WORKSPACE_CLEANUP_POLICY_MIN_DAYS } from '#lib/ade/workspaceCleanupPolicy.ts';

const enabled: JsonSchema = { type: 'object', properties: { enabled: { type: 'boolean' } }, additionalProperties: false };
const days: JsonSchema = { type: 'integer', minimum: WORKSPACE_CLEANUP_POLICY_MIN_DAYS, maximum: WORKSPACE_CLEANUP_POLICY_MAX_DAYS };

export const CLEANUP_RULES_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		merged: enabled,
		unchanged: { type: 'object', properties: { enabled: { type: 'boolean' }, afterDays: days }, additionalProperties: false },
		inactive: { type: 'object', properties: { enabled: { type: 'boolean' }, afterDays: days, action: { enum: WORKSPACE_CLEANUP_INACTIVE_ACTIONS } }, additionalProperties: false },
		automationRuns: enabled,
		orchestrationWorkers: enabled,
		keepWhen: { enum: WORKSPACE_CLEANUP_KEEP_WHEN_VALUES }
	},
	additionalProperties: false
};

export const CLEANUP_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.workspaceCleanup.auto',
		group: 'Workspace Cleanup',
		type: 'boolean',
		default: false,
		description:
			'ล้าง workspace อัตโนมัติตามกฎ (Orca: auto cleanup) ปิดไว้ก่อน เมื่อเปิด Kingu จะตรวจทุกชั่วโมงขณะเปิดโฟลเดอร์ แล้วลบเฉพาะ task ที่กฎบอกว่าลบได้ และไม่แตะงานที่ยังไม่ commit/push หรือ agent ที่ยังเปิดอยู่ (Remove finished workspaces by your rules without asking: off by default; checks hourly while a folder is open and never touches unsaved work or a live agent.)',
		scope: 'application'
	},
	{
		id: 'kingu.workspaceCleanup.rules',
		group: 'Workspace Cleanup',
		type: 'json',
		schema: CLEANUP_RULES_SCHEMA,
		default: getDefaultWorkspaceCleanupRules(),
		description:
			'กฎล้าง workspace อัตโนมัติของทุกโปรเจกต์ (Orca: workspaceCleanupPolicy) ปิดทุกข้อไว้ก่อน: merged, unchanged, inactive, automationRuns, orchestrationWorkers และ keepWhen ("uncommitted" เก็บงานที่ยังไม่ commit/push, "any-local-files" เก็บไฟล์ที่ถูก ignore เช่น .env ด้วย) ตั้งในหน้า Workspace Cleanup (Global cleanup rules for every project; every rule is off by default. Set it in the Workspace Cleanup page.)',
		scope: 'application'
	},
	{
		id: 'kingu.workspaceCleanup.project',
		group: 'Workspace Cleanup',
		type: 'json',
		schema: {
			anyOf: [
				{ type: 'object', properties: {}, additionalProperties: false },
				{ type: 'object', properties: { mode: { const: 'off' } }, additionalProperties: false },
				{ type: 'object', properties: { mode: { const: 'custom' }, rules: CLEANUP_RULES_SCHEMA }, additionalProperties: false }
			]
		},
		default: {},
		description:
			'ค่าของโปรเจกต์นี้แทนกฎส่วนกลาง (Orca: repo.workspaceCleanupPolicy) ว่าง = ใช้กฎส่วนกลาง {"mode": "off"} = ปิดการล้างของโปรเจกต์นี้ {"mode": "custom", "rules": {...}} = ใช้กฎของตัวเอง ตั้งในหน้า Workspace Cleanup (This project\'s override of the global rules: empty inherits, off turns cleanup off, custom uses its own rules.)',
		scope: 'local'
	}
];
