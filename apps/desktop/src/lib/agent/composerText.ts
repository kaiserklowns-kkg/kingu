/** A task title from a prompt: its first non-empty line, collapsed and cut at 60 characters. */
export function taskTitleFromPrompt(prompt: string, max = 60): string {
	const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
	const flat = line.replace(/\s+/g, ' ');
	if ([...flat].length <= max) return flat;
	return [...flat].slice(0, max - 1).join('').trimEnd() + '…';
}
