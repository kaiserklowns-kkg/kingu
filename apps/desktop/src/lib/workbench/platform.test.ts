import { describe, expect, test } from 'bun:test';
import { detectPlatform, PROFILES, uiPlatform } from './platform';

describe('platform', () => {
	test('detects the OS from the user agent', () => {
		expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15')).toBe('mac');
		expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130')).toBe('windows');
		expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('linux');
		expect(detectPlatform('Mozilla/5.0 (Oceans 1.0) AppleWebKit/605.1.15')).toBe('oceans');
	});
	test('only live profiles apply; others fall back to macOS unless previewed', () => {
		expect(uiPlatform('mac', null)).toBe('mac');
		expect(uiPlatform('windows', null)).toBe('mac');
		expect(uiPlatform('oceans', null)).toBe('mac');
		expect(uiPlatform('mac', 'windows')).toBe('windows');
		expect(uiPlatform('windows', null, ['mac', 'windows'])).toBe('windows');
	});
	test('profiles reserve space for their window controls', () => {
		expect(PROFILES.mac.leftInset).toBeGreaterThan(0);
		expect(PROFILES.windows.rightControlsWidth).toBe(3 * 46);
		expect(PROFILES.oceans.windowControls).toBe('oceans');
	});
});
