// The Source Control Graph's layout (VS Code's scmHistory.ts swimlanes), pure so bun tests cover
// it. Rust (git_graph.rs) reads the commits newest first in topological order; each row gets the
// lanes coming in from the row above and going out to the row below, the column of its circle and
// the lines to draw. A lane is the commit it is heading for: a commit's circle sits in the first
// lane heading for it, other lanes heading for it join there, its first parent takes that lane
// over and every other parent gets a lane of its own (or joins the one already heading there).
//
// With an upstream, the commits only HEAD has are outgoing and the ones only the upstream has are
// incoming (`scm.graph.showOutgoingChanges` / `showIncomingChanges`); the "Outgoing Changes" and
// "Incoming Changes" rows are virtual commits put above HEAD and above the merge base.

export type RefKind = 'branch' | 'remote' | 'tag';
export type GraphRef = { name: string; kind: RefKind; current: boolean };

/** One commit (Rust `git_graph::GraphCommit`). */
export type GraphCommit = {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	author_time: number;
	commit_time: number;
	subject: string;
	body: string;
	refs: GraphRef[];
};

export type Upstream = { name: string; hash: string };

/** One page of the graph (Rust `git_graph::GraphPage`). */
export type GraphPage = { commits: GraphCommit[]; head: string | null; branch: string | null; upstream: Upstream | null; merge_base: string | null };

/** The ids of the virtual rows. */
export const OUTGOING_ID = 'scm-graph:outgoing';
export const INCOMING_ID = 'scm-graph:incoming';

export type Lane = { id: string; color: number };

export type RowKind = 'commit' | 'outgoing-changes' | 'incoming-changes';

export type GraphRow = {
	kind: RowKind;
	commit: GraphCommit;
	/** Column of the circle. */
	column: number;
	/** Color index of the circle. */
	color: number;
	lanesIn: Lane[];
	lanesOut: Lane[];
	/** Lanes passing by: from their column above to their column below. */
	through: { from: number; to: number; color: number }[];
	/** Lanes ending in the circle (the circle's own lane first, when it has one). */
	joins: { from: number; color: number }[];
	/** Lanes leaving the circle for its parents: their column below. */
	parents: { to: number; color: number }[];
	/** HEAD's commit. */
	head: boolean;
	/** Relative to the upstream: only HEAD has it, only the upstream has it, or neither. */
	side: 'outgoing' | 'incoming' | null;
};

/** How many lane colors the view has (scmGraph.foreground1…5 in VS Code). */
export const LANE_COLORS = 5;

/** Every loaded commit `from` reaches through parents (itself included). */
export function reachable(commits: readonly GraphCommit[], from: string | null | undefined): Set<string> {
	const byHash = new Map(commits.map((c) => [c.hash, c]));
	const seen = new Set<string>();
	const todo = from ? [from] : [];
	while (todo.length) {
		const h = todo.pop()!;
		if (seen.has(h) || !byHash.has(h)) continue;
		seen.add(h);
		todo.push(...byHash.get(h)!.parents);
	}
	return seen;
}

export type LayoutOptions = {
	head?: string | null;
	upstream?: Upstream | null;
	mergeBase?: string | null;
	/** Add the "Outgoing Changes" row above HEAD (there are outgoing commits). */
	outgoingRow?: boolean;
	/** Add the "Incoming Changes" row above the merge base (there are incoming commits). */
	incomingRow?: boolean;
	/** Subjects of the virtual rows. */
	labels?: { outgoing: string; incoming: string };
};

function virtual(id: string, parent: string, subject: string): GraphCommit {
	return { hash: id, parents: [parent], author: '', email: '', author_time: 0, commit_time: 0, subject, body: '', refs: [] };
}

/** The commits with the virtual rows put in (see the module comment). */
export function withVirtualRows(commits: readonly GraphCommit[], opts: LayoutOptions): GraphCommit[] {
	const { head, upstream, mergeBase } = opts;
	let list = [...commits];
	if (!head || !upstream || !mergeBase) return list;
	const labels = opts.labels ?? { outgoing: 'Outgoing Changes', incoming: 'Incoming Changes' };
	if (opts.incomingRow && upstream.hash !== mergeBase && upstream.hash !== head) {
		const at = list.findIndex((c) => c.hash === mergeBase);
		const incoming = reachable(list, upstream.hash);
		const mine = reachable(list, head);
		if (at >= 0) {
			// Incoming commits that sat on the merge base now sit on the Incoming Changes row.
			list = list.map((c) => (incoming.has(c.hash) && !mine.has(c.hash) && c.parents.includes(mergeBase) ? { ...c, parents: c.parents.map((p) => (p === mergeBase ? INCOMING_ID : p)) } : c));
			list.splice(at, 0, virtual(INCOMING_ID, mergeBase, labels.incoming));
		}
	}
	if (opts.outgoingRow && head !== mergeBase) {
		const at = list.findIndex((c) => c.hash === head);
		if (at >= 0) list.splice(at, 0, virtual(OUTGOING_ID, head, labels.outgoing));
	}
	return list;
}

/** Lays out the rows of `commits` (newest first, topological order). */
export function layoutGraph(commits: readonly GraphCommit[], opts: LayoutOptions = {}): GraphRow[] {
	const list = withVirtualRows(commits, opts);
	const outgoing = new Set<string>();
	const incoming = new Set<string>();
	if (opts.head && opts.upstream) {
		const mine = reachable(list, opts.head);
		const theirs = reachable(list, opts.upstream.hash);
		for (const h of mine) if (!theirs.has(h)) outgoing.add(h);
		for (const h of theirs) if (!mine.has(h)) incoming.add(h);
	}
	let next = 0;
	const color = () => next++ % LANE_COLORS;
	const rows: GraphRow[] = [];
	let lanes: Lane[] = [];
	for (const commit of list) {
		const lanesIn = lanes;
		let column = lanesIn.findIndex((l) => l.id === commit.hash);
		const tip = column < 0;
		if (tip) column = lanesIn.length;
		const own = tip ? color() : lanesIn[column].color;
		const out: Lane[] = [];
		const joins: GraphRow['joins'] = [];
		let placed = false;
		for (const [i, l] of lanesIn.entries()) {
			if (l.id !== commit.hash) {
				out.push(l);
				continue;
			}
			joins.push({ from: i, color: l.color });
			// The first lane heading here goes on to the first parent; the others end.
			if (!placed && commit.parents.length) out.push({ id: commit.parents[0], color: own });
			placed = true;
		}
		if (!placed && commit.parents.length) out.push({ id: commit.parents[0], color: own });
		const parents: GraphRow['parents'] = [];
		for (const [i, p] of commit.parents.entries()) {
			if (i === 0) {
				parents.push({ to: tip ? out.length - 1 : column, color: own });
				continue;
			}
			let j = out.findIndex((l) => l.id === p);
			if (j < 0) {
				out.push({ id: p, color: color() });
				j = out.length - 1;
			}
			parents.push({ to: j, color: out[j].color });
		}
		const through: GraphRow['through'] = [];
		for (const [i, l] of lanesIn.entries()) {
			if (l.id === commit.hash) continue;
			through.push({ from: i, to: out.indexOf(l), color: l.color });
		}
		const side = incoming.has(commit.hash) || commit.hash === INCOMING_ID ? 'incoming' : outgoing.has(commit.hash) || commit.hash === OUTGOING_ID ? 'outgoing' : null;
		rows.push({
			kind: commit.hash === OUTGOING_ID ? 'outgoing-changes' : commit.hash === INCOMING_ID ? 'incoming-changes' : 'commit',
			commit,
			column,
			color: own,
			lanesIn,
			lanesOut: out,
			through,
			joins,
			parents,
			head: commit.hash === opts.head,
			side
		});
		lanes = out;
	}
	return rows;
}

/** How many columns the graph needs (its width). */
export const graphWidth = (rows: readonly GraphRow[]) => rows.reduce((n, r) => Math.max(n, r.lanesIn.length, r.lanesOut.length, r.column + 1), 0);

/**
 * The labels a row shows (`scm.graph.badges`): every branch and tag (`all`), or only the refs the
 * graph is drawn for (`filter`): the current branch and its upstream, every branch when the graph
 * shows them all. The current branch comes first, then its upstream, branches, remotes, tags.
 */
export function rowBadges(refs: readonly GraphRef[], mode: string, ctx: { branch: string | null; upstream: string | null; allRefs?: boolean }): GraphRef[] {
	const rank = (r: GraphRef) => (r.current ? 0 : r.name === ctx.upstream ? 1 : r.kind === 'branch' ? 2 : r.kind === 'remote' ? 3 : 4);
	const shown = mode === 'all' || ctx.allRefs ? [...refs] : refs.filter((r) => (r.kind === 'branch' && r.name === ctx.branch) || (r.kind === 'remote' && r.name === ctx.upstream));
	return shown.sort((a, b) => rank(a) - rank(b));
}

/** The graph rows' hover text: subject and body, author, date and the short hash. */
export function commitHover(c: GraphCommit, when: string, hashLength = 7): string {
	const message = c.body ? `${c.subject}\n\n${c.body}` : c.subject;
	const refs = c.refs.length ? `\n\n${c.refs.map((r) => (r.kind === 'tag' ? `tag: ${r.name}` : r.name)).join(', ')}` : '';
	return `${c.author} <${c.email}>, ${when}\n\n${message}${refs}\n\n${c.hash.slice(0, hashLength)}`;
}

/** A commit's message for Copy Commit Message. */
export const commitMessage = (c: GraphCommit) => (c.body ? `${c.subject}\n\n${c.body}` : c.subject);

/** `scm.graph.pageSize` as a page size (1…1000; VS Code's default 50). */
export function pageSize(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 1000) : 50;
}

/** Commits of `next` not already in `loaded` (a page read after the history moved). */
export function appendPage(loaded: readonly GraphCommit[], next: readonly GraphCommit[]): GraphCommit[] {
	const seen = new Set(loaded.map((c) => c.hash));
	return [...loaded, ...next.filter((c) => !seen.has(c.hash))];
}
