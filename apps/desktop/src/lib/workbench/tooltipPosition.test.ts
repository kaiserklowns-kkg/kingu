import { describe, expect, test } from 'bun:test';
import { tooltipPosition } from './tooltipPosition';

describe('tooltipPosition', () => {
	const tip = { width: 100, height: 24 };
	test('centered below the anchor', () => {
		expect(tooltipPosition({ left: 200, top: 10, right: 240, bottom: 30 }, tip, 1000, 800)).toEqual({ x: 170, y: 36, above: false });
	});
	test('above when there is no room below, inside the window horizontally', () => {
		expect(tooltipPosition({ left: 980, top: 780, right: 1000, bottom: 798 }, tip, 1000, 800)).toEqual({ x: 896, y: 750, above: true });
		expect(tooltipPosition({ left: 0, top: 10, right: 10, bottom: 20 }, tip, 1000, 800).x).toBe(4);
	});
});
