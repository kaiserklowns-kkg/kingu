import { describe, expect, test } from 'bun:test';
import { compactCodicon, drawsIcon, ICON_CODICON } from './chatIcons.ts';

describe('chat icons', () => {
	test('every Kingu icon maps to an icon that draws', () => {
		const missing = Object.entries(ICON_CODICON).filter(([, id]) => !drawsIcon(id));
		expect(missing).toEqual([]);
	});

	test('compact variants as VS Code picks them (getCompactCodicon)', () => {
		expect(compactCodicon('agent')).toBe('agent-compact');
		expect(compactCodicon('add')).toBe('add-compact');
		expect(compactCodicon('mic')).toBe('mic-compact');
		// No question-compact: the icon itself.
		expect(compactCodicon('question')).toBe('question');
	});
});
