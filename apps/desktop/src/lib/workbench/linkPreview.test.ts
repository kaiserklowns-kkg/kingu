import { describe, expect, test } from 'bun:test';
import { cardPlacement, CARD_WIDTH } from './linkPreview';

describe('cardPlacement', () => {
	const view = { width: 1000, height: 800 };
	test('below the link when it fits', () => {
		expect(cardPlacement({ left: 100, top: 100, bottom: 120 }, view)).toEqual({ left: 100, top: 126 });
	});
	test('above the link near the bottom', () => {
		expect(cardPlacement({ left: 100, top: 700, bottom: 720 }, view).top).toBe(700 - 260 - 6);
	});
	test('kept inside the window on the right', () => {
		expect(cardPlacement({ left: 950, top: 10, bottom: 30 }, view).left).toBe(1000 - CARD_WIDTH - 6);
	});
});
