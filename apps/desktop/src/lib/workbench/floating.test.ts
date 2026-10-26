import { expect, test } from 'bun:test';
import { anchorButton, anchorRect, browserUrl, buttonPos, clampRect, DEFAULT_BOUNDS, DEFAULT_BUTTON, defaultRect, maximizedRect, rectFromAnchor, resizeRect } from './floating';

test('default panel sits bottom right, 920×560', () => {
	expect(defaultRect(1440, 900)).toEqual({ width: 920, height: 560, left: 496, top: 256 });
	expect(rectFromAnchor(DEFAULT_BOUNDS, 1440, 900)).toEqual({ left: 496, top: 256, width: 920, height: 560 });
	expect(defaultRect(600, 400)).toEqual({ width: 552, height: 304, left: 24, top: 36 });
});

test('clamped under the title bar at the minimum size', () => {
	expect(clampRect({ left: -50, top: 0, width: 100, height: 100 }, 1440, 900)).toEqual({ left: 8, top: 36, width: 420, height: 280 });
	expect(maximizedRect(1440, 900)).toEqual({ left: 12, top: 36, width: 1416, height: 828 });
});

test('anchoring keeps the distance to the nearest corner', () => {
	const r = { left: 100, top: 600, width: 500, height: 280 };
	const a = anchorRect(r, 1440, 900);
	expect(a).toEqual({ anchorX: 'left', anchorY: 'bottom', offsetX: 100, offsetY: 20, width: 500, height: 280 });
	expect(rectFromAnchor(a, 1600, 1000)).toEqual({ left: 100, top: 700, width: 500, height: 280 });
});

test('button anchoring and clamping', () => {
	expect(buttonPos(DEFAULT_BUTTON, 1440, 900)).toEqual({ left: 1380, top: 792 });
	expect(anchorButton({ left: 20, top: 50 }, 1440, 900)).toEqual({ anchorX: 'left', anchorY: 'top', offsetX: 20, offsetY: 50 });
	expect(buttonPos({ anchorX: 'left', anchorY: 'top', offsetX: -5, offsetY: 0 }, 1440, 900)).toEqual({ left: 8, top: 36 });
});

test('resizing from the west edge keeps the east edge', () => {
	const r = { left: 100, top: 100, width: 500, height: 400 };
	expect(resizeRect(r, 'w', 50, 0)).toEqual({ left: 150, top: 100, width: 450, height: 400 });
	expect(resizeRect(r, 'nw', 300, 300)).toEqual({ left: 180, top: 220, width: 420, height: 280 });
	expect(resizeRect(r, 'se', 10, 20)).toEqual({ left: 100, top: 100, width: 510, height: 420 });
});

test('a bare host loads over http only on this machine', () => {
	expect(browserUrl('localhost:3000')).toBe('http://localhost:3000');
	expect(browserUrl('127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
	expect(browserUrl('example.com/docs')).toBe('https://example.com/docs');
	expect(browserUrl('https://example.com')).toBe('https://example.com');
	expect(browserUrl('about:blank')).toBe('about:blank');
	expect(browserUrl('  ')).toBe('about:blank');
});
