import { describe, expect, test } from 'bun:test';
import { clampRect, defaultRect } from './floating';

describe('floating terminal geometry', () => {
	test('stays inside the window and above the minimum size', () => {
		expect(clampRect({ x: -50, y: 900, w: 100, h: 50 }, 1200, 800)).toEqual({ x: 8, y: 592, w: 360, h: 200 });
		expect(clampRect({ x: 100, y: 100, w: 5000, h: 5000 }, 1200, 800)).toEqual({ x: 8, y: 8, w: 1184, h: 784 });
	});
	test('defaults to the bottom right', () => {
		expect(defaultRect(1440, 900)).toEqual({ x: 776, y: 492, w: 640, h: 360 });
	});
});
