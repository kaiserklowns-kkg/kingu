// Pure halves of the editor toggles (editingCommands.svelte.ts), for bun tests.

export type WordWrapOverride = 'on' | 'off' | 'inherit';

/**
 * Toggle Word Wrap (VS Code toggleWordWrap.ts): a file that follows the setting gets the
 * opposite of what it shows; a file already toggled goes the other way. `wrapping`: whether the
 * editor wraps now (`editor.wordWrap` other than `off`, or a bounded/column wrap).
 */
export function nextWordWrapOverride(current: WordWrapOverride, setting: string, wrapping: boolean): WordWrapOverride {
	if (current === 'inherit') return setting !== 'off' || wrapping ? 'off' : 'on';
	return current === 'on' ? 'off' : 'on';
}
