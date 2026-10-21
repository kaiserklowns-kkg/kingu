import { describe, expect, test } from 'bun:test';
import { clickZoomsOut, MAX_SCALE, MIN_SCALE, PICK_SCALES, zoomByWheel, zoomIn, zoomLabel, zoomOut } from './imageZoom.ts';

describe('image preview zoom', () => {
	test('steps through VS Code’s levels', () => {
		expect(zoomIn(1, 1)).toBe(1.5);
		expect(zoomIn(1.5, 1)).toBe(2);
		expect(zoomOut(1, 1)).toBe(0.9);
		expect(zoomOut(0.15, 1)).toBe(0.1);
		// Between levels: the next one either way.
		expect(zoomIn(0.95, 1)).toBe(1);
		expect(zoomOut(0.95, 1)).toBe(0.9);
		// At the ends it stays.
		expect(zoomIn(MAX_SCALE, 1)).toBe(MAX_SCALE);
		expect(zoomOut(MIN_SCALE, 1)).toBe(MIN_SCALE);
	});

	test('from Whole Image it starts at the fitted scale', () => {
		expect(zoomIn('fit', 0.42)).toBe(0.5);
		expect(zoomOut('fit', 0.42)).toBe(0.4);
		// A small image shown at its own size (fitted 1).
		expect(zoomIn('fit', 1)).toBe(1.5);
		// No fitted scale known yet: as if 100%.
		expect(zoomIn('fit', 0)).toBe(1.5);
	});

	test('wheel and pinch zoom smoothly within the limits', () => {
		expect(zoomByWheel(1, 1, -10)).toBeGreaterThan(1);
		expect(zoomByWheel(1, 1, 10)).toBeLessThan(1);
		expect(zoomByWheel(MAX_SCALE, 1, -1000)).toBe(MAX_SCALE);
		expect(zoomByWheel(MIN_SCALE, 1, 1000)).toBe(MIN_SCALE);
	});

	test('labels, picker levels and the zoom-out click', () => {
		expect(zoomLabel('fit', 'Whole Image')).toBe('Whole Image');
		expect(zoomLabel(1.5, 'Whole Image')).toBe('150%');
		expect(zoomLabel(0.333, 'x')).toBe('33%');
		expect(PICK_SCALES.at(-1)).toBe('fit');
		expect(clickZoomsOut({ altKey: true, ctrlKey: false }, true)).toBe(true);
		expect(clickZoomsOut({ altKey: false, ctrlKey: true }, true)).toBe(false);
		expect(clickZoomsOut({ altKey: false, ctrlKey: true }, false)).toBe(true);
	});
});
