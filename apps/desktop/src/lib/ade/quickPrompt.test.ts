import { expect, test } from 'bun:test';
import { quickPromptArgv } from './quickPrompt.ts';
import { PROFILES, profileOf } from './agentProfiles.ts';

test('claude and codex take the prompt as their last argument', () => {
	expect(quickPromptArgv('claude', 'review the diff')?.at(-1)).toBe('review the diff');
	expect(quickPromptArgv('', 'review the diff')?.[0]).toBe('claude');
	expect(quickPromptArgv('codex', 'fix it')).toContain('fix it');
});

test('no prompt, or a CLI that cannot take one at launch, gives null', () => {
	expect(quickPromptArgv('claude', '  ')).toBeNull();
	const pasted = PROFILES.find((p) => p.bins.length && p.launch([p.bins[0]], { prompt: 'x' }, { servers: {}, plugins: [] }).typePrompt !== undefined);
	if (pasted) expect(quickPromptArgv(pasted.bins[0], 'x')).toBeNull();
	expect(profileOf(['claude']).id).toBe('claude');
});
