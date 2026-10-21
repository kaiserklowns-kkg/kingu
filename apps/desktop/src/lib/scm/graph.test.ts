import { describe, expect, test } from 'bun:test';
import { appendPage, commitHover, commitMessage, graphWidth, INCOMING_ID, layoutGraph, OUTGOING_ID, pageSize, reachable, rowBadges, withVirtualRows, type GraphCommit, type GraphRef } from './graph';

const c = (hash: string, parents: string[] = [], refs: GraphRef[] = []): GraphCommit => ({
	hash,
	parents,
	author: 'Ann',
	email: 'ann@example.com',
	author_time: 1,
	commit_time: 1,
	subject: `subject ${hash}`,
	body: '',
	refs
});

const shape = (rows: ReturnType<typeof layoutGraph>) => rows.map((r) => `${r.commit.hash}@${r.column}:${r.lanesOut.map((l) => l.id).join(',')}`);

describe('layoutGraph', () => {
	test('a straight history stays in one column', () => {
		const rows = layoutGraph([c('c', ['b']), c('b', ['a']), c('a')]);
		expect(shape(rows)).toEqual(['c@0:b', 'b@0:a', 'a@0:']);
		expect(rows[0].joins).toEqual([]);
		expect(rows[1].joins).toEqual([{ from: 0, color: rows[0].color }]);
		expect(rows.every((r) => r.color === rows[0].color)).toBe(true);
		expect(rows[2].parents).toEqual([]);
		expect(graphWidth(rows)).toBe(1);
	});

	test('a merge opens a lane for its second parent and the branch joins back at the fork', () => {
		// m merges b (main) and s (side); both come from a.
		const rows = layoutGraph([c('m', ['b', 's']), c('s', ['a']), c('b', ['a']), c('a')]);
		expect(shape(rows)).toEqual(['m@0:b,s', 's@1:b,a', 'b@0:a,a', 'a@0:']);
		const [m, s, b, a] = rows;
		expect(m.parents.map((p) => p.to)).toEqual([0, 1]);
		expect(m.parents[1].color).not.toBe(m.color);
		// s keeps its lane's color; main's lane passes by it.
		expect(s.color).toBe(m.parents[1].color);
		expect(s.through).toEqual([{ from: 0, to: 0, color: m.color }]);
		expect(b.through).toEqual([{ from: 1, to: 1, color: s.color }]);
		// Both lanes heading for a end in its circle.
		expect(a.joins.map((j) => j.from)).toEqual([0, 1]);
		expect(graphWidth(rows)).toBe(2);
	});

	test('a second parent that already has a lane joins it instead of opening another', () => {
		// x and y are tips; y merges x's parent p, which x's lane already heads for.
		const rows = layoutGraph([c('x', ['p']), c('y', ['q', 'p']), c('q', ['p']), c('p')]);
		expect(shape(rows)).toEqual(['x@0:p', 'y@1:p,q', 'q@1:p,p', 'p@0:']);
		expect(rows[1].parents).toEqual([
			{ to: 1, color: rows[1].color },
			{ to: 0, color: rows[0].color }
		]);
	});

	test('tips start new columns and HEAD is marked', () => {
		const rows = layoutGraph([c('t1', ['a']), c('t2', ['a']), c('a')], { head: 't2' });
		expect(shape(rows)).toEqual(['t1@0:a', 't2@1:a,a', 'a@0:']);
		expect(rows.map((r) => r.head)).toEqual([false, true, false]);
		expect(rows[1].joins).toEqual([]);
	});

	test('marks outgoing and incoming commits and adds the virtual rows', () => {
		// base ← mine (HEAD), base ← theirs (upstream).
		const commits = [c('theirs', ['base']), c('mine', ['base']), c('base', ['old']), c('old')];
		const opts = { head: 'mine', upstream: { name: 'origin/main', hash: 'theirs' }, mergeBase: 'base' };
		const plain = layoutGraph(commits, opts);
		expect(plain.map((r) => r.side)).toEqual(['incoming', 'outgoing', null, null]);

		const rows = layoutGraph(commits, { ...opts, outgoingRow: true, incomingRow: true, labels: { outgoing: 'Out', incoming: 'In' } });
		expect(rows.map((r) => r.kind)).toEqual(['commit', 'outgoing-changes', 'commit', 'incoming-changes', 'commit', 'commit']);
		expect(rows.map((r) => r.commit.hash)).toEqual(['theirs', OUTGOING_ID, 'mine', INCOMING_ID, 'base', 'old']);
		expect(rows[1].commit.subject).toBe('Out');
		expect(rows[1].side).toBe('outgoing');
		expect(rows[3].side).toBe('incoming');
		// The incoming commit now heads for the Incoming Changes row, which heads for the merge base.
		expect(rows[0].commit.parents).toEqual([INCOMING_ID]);
		expect(rows[3].commit.parents).toEqual(['base']);
		// HEAD's circle continues the Outgoing Changes row's lane.
		expect(rows[2].joins.map((j) => j.from)).toEqual([rows[1].column]);
		expect(rows[2].head).toBe(true);
	});

	test('no virtual rows without commits on that side or with the anchor not loaded', () => {
		const commits = [c('mine', ['base']), c('base')];
		const up = { name: 'origin/main', hash: 'base' };
		expect(withVirtualRows(commits, { head: 'mine', upstream: up, mergeBase: 'base', incomingRow: true, outgoingRow: true }).map((x) => x.hash)).toEqual([OUTGOING_ID, 'mine', 'base']);
		expect(withVirtualRows(commits, { head: 'base', upstream: up, mergeBase: 'base', incomingRow: true, outgoingRow: true }).map((x) => x.hash)).toEqual(['mine', 'base']);
		// The merge base is on a later page: no Incoming Changes row yet.
		const later = [c('theirs', ['base']), c('mine', ['base'])];
		expect(withVirtualRows(later, { head: 'mine', upstream: { name: 'o', hash: 'theirs' }, mergeBase: 'base', incomingRow: true }).map((x) => x.hash)).toEqual(['theirs', 'mine']);
		expect(withVirtualRows(commits, { head: 'mine', incomingRow: true, outgoingRow: true })).toEqual(commits);
	});
});

describe('graph helpers', () => {
	test('reachable follows parents within the loaded commits', () => {
		const commits = [c('c', ['b', 'x']), c('b', ['a']), c('a')];
		expect([...reachable(commits, 'c')].sort()).toEqual(['a', 'b', 'c']);
		expect(reachable(commits, null).size).toBe(0);
	});

	test('badges follow scm.graph.badges', () => {
		const refs: GraphRef[] = [
			{ name: 'v1', kind: 'tag', current: false },
			{ name: 'origin/main', kind: 'remote', current: false },
			{ name: 'feature', kind: 'branch', current: false },
			{ name: 'main', kind: 'branch', current: true },
			{ name: 'origin/feature', kind: 'remote', current: false }
		];
		const ctx = { branch: 'main', upstream: 'origin/main' };
		expect(rowBadges(refs, 'filter', ctx).map((r) => r.name)).toEqual(['main', 'origin/main']);
		expect(rowBadges(refs, 'all', ctx).map((r) => r.name)).toEqual(['main', 'origin/main', 'feature', 'origin/feature', 'v1']);
		expect(rowBadges(refs, 'filter', { ...ctx, allRefs: true })).toHaveLength(5);
	});

	test('hover, message, page size and paging', () => {
		const commit = { ...c('0123456789abcdef', [], [{ name: 'v2', kind: 'tag', current: false }]), body: 'Body' };
		expect(commitHover(commit, 'today')).toBe('Ann <ann@example.com>, today\n\nsubject 0123456789abcdef\n\nBody\n\ntag: v2\n\n0123456');
		expect(commitMessage(commit)).toBe('subject 0123456789abcdef\n\nBody');
		expect(commitMessage(c('a'))).toBe('subject a');
		expect([pageSize(20), pageSize(0), pageSize('x'), pageSize(5000), pageSize(7.6)]).toEqual([20, 50, 50, 1000, 7]);
		expect(appendPage([c('a'), c('b')], [c('b'), c('c')]).map((x) => x.hash)).toEqual(['a', 'b', 'c']);
	});
});
