import { expect, test } from 'bun:test';
import { contextLevel, contextPercent, formatTokens, ringDash } from './contextUsage';

test('context window percent, level and labels', () => {
	expect(contextPercent({ used: 50_000, max: 200_000 })).toBe(25);
	expect(contextPercent({ used: 250_000, max: 200_000 })).toBe(100);
	expect(contextPercent({ used: 5, max: 0 })).toBe(0);
	expect(contextPercent(null)).toBe(0);
	expect([contextLevel(79), contextLevel(80), contextLevel(95)]).toEqual(['ok', 'warn', 'full']);
	expect([formatTokens(950), formatTokens(12_345), formatTokens(200_000), formatTokens(1_000_000)]).toEqual(['950', '12.3k', '200k', '1M']);
	expect(ringDash(50, 10)).toBe('31.42 62.83');
	expect(ringDash(150, 10)).toBe('62.83 62.83');
});
