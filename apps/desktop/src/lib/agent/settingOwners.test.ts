import { describe, expect, test } from 'bun:test';
import { SETTINGS } from '#lib/settings/registry.ts';
import { isAiSetting, ownerOf } from './settingOwners';

describe('AI setting owners (docs/AI-SURFACES.md §4)', () => {
	test('every kingu.agent.* / kingu.chat.* setting has an owner', () => {
		const ai = SETTINGS.map((s) => s.id).filter(isAiSetting);
		expect(ai.length).toBeGreaterThan(20);
		for (const id of ai) expect([id, ownerOf(id)]).not.toEqual([id, null]);
	});

	test('the table of §4', () => {
		expect(ownerOf('kingu.agent.runtime')).toBe('ide');
		expect(ownerOf('kingu.chat.reasoningEffort')).toBe('ide');
		expect(ownerOf('kingu.agent.cli')).toBe('ade');
		expect(ownerOf('kingu.agent.args.claude')).toBe('ade');
		expect(ownerOf('kingu.agent.env.qoder-cn')).toBe('ade');
		expect(ownerOf('kingu.agent.permissionMode')).toBe('shared');
		expect(ownerOf('kingu.agent.notifications.sound')).toBe('shared');
		expect(ownerOf('kingu.agent.args')).toBeNull();
		expect(ownerOf('kingu.agent.somethingNew')).toBeNull();
	});
});
