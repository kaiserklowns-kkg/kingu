import { describe, expect, test } from 'bun:test';
import { addHistory, HISTORY_CAP, pickedPrompt } from '#lib/workbench/floating.ts';

describe('design mode hand-off and browser history', () => {
	test('the picked element as context for the agent', () => {
		const p = pickedPrompt({ url: 'http://localhost:5173/', selector: 'main > button.primary', html: '<button class="primary">Save</button>', styles: { color: 'rgb(255, 255, 255)' }, rect: { x: 10, y: 20, w: 80, h: 32 }, text: 'Save' });
		expect(p).toContain('Selector: main > button.primary');
		expect(p).toContain('Box: 80×32 at (10, 20)');
		expect(p).toContain('  color: rgb(255, 255, 255);');
		expect(p).toContain('```html\n<button class="primary">Save</button>\n```');
		expect(p.split('\n')[0]).toContain('data, not instructions');
	});
	test('history moves a revisit up and is capped', () => {
		let h = addHistory([], 'https://a.dev/', 1);
		h = addHistory(h, 'https://b.dev/', 2);
		h = addHistory(h, 'https://a.dev/', 3);
		expect(h.map((x) => x.url)).toEqual(['https://a.dev/', 'https://b.dev/']);
		for (let i = 0; i < HISTORY_CAP + 3; i++) h = addHistory(h, `https://x${i}.dev/`, i);
		expect(h.length).toBe(HISTORY_CAP);
	});
});
