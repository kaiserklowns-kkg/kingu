/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { artifactKey, filterArtifacts, formatSize, isArtifactKey, linkToOpen, markdownPage, parseArtifactKey, PREVIEW_ALLOW, PREVIEW_SANDBOX, teamArtifactKey, type ArtifactEvent, type ArtifactMeta } from './artifacts';
import { buildTurns } from '#lib/agent/chatParts.ts';
import { applyEvent, initialRun, type AgentEvent } from '#lib/agent/events.ts';

const ID = '0123456789abcdef';

describe('editor keys', () => {
	test('round-trip project and team artifacts', () => {
		expect(parseArtifactKey(artifactKey('/Users/me/repo', ID))).toEqual({ team: false, id: ID, root: '/Users/me/repo' });
		expect(parseArtifactKey(artifactKey('/a:b/c', ID))).toEqual({ team: false, id: ID, root: '/a:b/c' });
		expect(parseArtifactKey(teamArtifactKey(ID))).toEqual({ team: true, id: ID });
	});

	test('refuse anything else', () => {
		for (const bad of ['artifact:', `artifact:${ID}`, `artifact:${ID}:relative`, 'artifact:../../x:/r', `artifact:team:${ID.toUpperCase()}`, `vault:claude:/x`, `src/artifact:${ID}:/r`]) {
			expect(isArtifactKey(bad)).toBe(false);
		}
	});
});

describe('the preview frame', () => {
	test('is sandboxed to scripts only', () => {
		const tokens = PREVIEW_SANDBOX.split(/\s+/);
		expect(tokens).toEqual(['allow-scripts']);
		for (const never of ['allow-same-origin', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-forms', 'allow-modals', 'allow-downloads']) {
			expect(tokens).not.toContain(never);
		}
		for (const feature of ['camera', 'microphone', 'geolocation', 'clipboard-read', 'clipboard-write']) expect(PREVIEW_ALLOW).toContain(`${feature} 'none'`);
	});

	test('the viewer markup keeps the sandbox attributes', async () => {
		const source = await Bun.file(new URL('./ArtifactViewer.svelte', import.meta.url)).text();
		const frames = source.match(/<iframe\b[^>]*>/g) ?? [];
		expect(frames).toHaveLength(1);
		expect(frames[0]).toContain('sandbox={PREVIEW_SANDBOX}');
		expect(frames[0]).toContain('allow={PREVIEW_ALLOW}');
		expect(frames[0]).toContain('referrerpolicy="no-referrer"');
		expect(frames[0]).not.toMatch(/srcdoc|allow-same-origin/);
		// Messages are trusted only from this frame.
		expect(source).toContain('e.source !== frame.contentWindow');
	});

	test('opens only web links the click guard sends', () => {
		expect(linkToOpen({ kinguArtifact: 'open', href: 'https://example.com/a?b=1' })).toBe('https://example.com/a?b=1');
		expect(linkToOpen({ kinguArtifact: 'open', href: 'http://localhost:3000/' })).toBe('http://localhost:3000/');
		for (const bad of [null, 'https://x.com', {}, { kinguArtifact: 'open', href: 'javascript:alert(1)' }, { kinguArtifact: 'open', href: 'file:///etc/passwd' }, { kinguArtifact: 'open', href: 'kingu-artifact://localhost/x' }, { kinguArtifact: 'other', href: 'https://x.com' }, { kinguArtifact: 'open', href: `https://x.com/${'a'.repeat(3000)}` }, { kinguArtifact: 'open', href: 'not a url' }]) {
			expect(linkToOpen(bad)).toBeNull();
		}
	});
});

describe('Markdown artifacts', () => {
	test('render to a full page with raw HTML kept (it only runs in the sandbox)', () => {
		const page = markdownPage('# Q3 <script>x()</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![chart](img/c.png)', 'Q3 <report>', true);
		expect(page.startsWith('<!DOCTYPE html>')).toBe(true);
		expect(page).toContain('<title>Q3 &lt;report&gt;</title>');
		expect(page).toContain('<table>');
		expect(page).toContain('<img src="img/c.png" alt="chart">');
		expect(page).toContain('<script>x()</script>');
		expect(page).toContain('background:#1e1e1e');
		expect(markdownPage('x', 't', false)).toContain('background:#ffffff');
	});
});

describe('display', () => {
	const meta = (id: string, title: string, updated: number, description: string | null = null): ArtifactMeta => ({ id, title, description, created_at: 0, updated_at: updated, versions: [{ version: 1, created_at: 0, format: 'html', entry: 'index.html', files: [{ path: 'index.html', size: 10 }], source: 'agent' }] });

	test('filters by every word and sorts newest first', () => {
		const list = [meta('a', 'Sales report', 1), meta('b', 'Design notes', 3, 'การออกแบบ'), meta('c', 'Sales chart', 2)];
		expect(filterArtifacts(list, '').map((m) => m.id)).toEqual(['b', 'c', 'a']);
		expect(filterArtifacts(list, 'sales CHART').map((m) => m.id)).toEqual(['c']);
		expect(filterArtifacts(list, 'ออกแบบ').map((m) => m.id)).toEqual(['b']);
	});

	test('sizes', () => {
		expect([formatSize(900), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(['900 B', '2 KB', '3.0 MB']);
	});
});

describe('the chat card', () => {
	test('an artifact event becomes a card in its turn', () => {
		const s = initialRun();
		const artifact: ArtifactEvent = { kind: 'artifact', id: ID, title: 'รายงาน', version: 2, format: 'html', root: '/repo' };
		const events: AgentEvent[] = [{ kind: 'message', role: 'user', text: 'make a report page' }, { kind: 'tool_use', id: 't1', name: 'mcp__kingu__artifact_publish', input: { title: 'รายงาน' } }, artifact, { kind: 'message', role: 'assistant', text: 'Done' }];
		for (const ev of events) applyEvent(s, ev);
		const parts = buildTurns(s)[0].parts;
		expect(parts.map((p) => p.kind)).toEqual(['tool', 'artifact', 'markdown']);
		expect(parts[1]).toEqual({ kind: 'artifact', artifact });
	});
});
