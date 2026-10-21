// Problem collectors (VS Code: src/vs/workbench/contrib/tasks/common/problemCollectors.ts): feed
// a task's output lines through its matchers and keep the markers service in step, per owner and
// resource, the way VS Code does: a run first records every resource its owners have markers
// on, a resource that gets new markers is replaced, and when the run ends (or a background
// watcher's endsPattern matches) whatever the run did not report again is removed.

import { createLineMatcher, getResource, type ApplyTo, type FileHost, type LineMatcherApi, type Marker, type ProblemMatch, type ProblemMatcher, type Severity } from './problemMatcher.ts';

/** The markers service the collectors write to (Kingu: the Problems panel's task markers). */
export interface MarkerStore {
	/** Resources (absolute paths) holding markers of `owner`. */
	resources(owner: string): string[];
	/** Replaces the markers of `owner` on `resource`. */
	change(owner: string, resource: string, markers: Marker[]): void;
	remove(owner: string, resources: string[]): void;
	/** The file is open in an editor (applyTo openDocuments / closedDocuments). */
	isOpen(resource: string): boolean;
}

export type CollectorEvent = { kind: 'begins' } | { kind: 'ends'; captured?: Map<string, string> };

const RANK: Record<Severity, number> = { info: 1, warning: 2, error: 3 };

function markerKey(m: Marker): string {
	return [m.source ?? '', m.code ?? '', m.severity, m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn, m.message].join('\u0000');
}

abstract class Collector {
	#matchers = new Map<number, LineMatcherApi[]>();
	#active: LineMatcherApi | null = null;
	#buffer: string[] = [];
	#bufferLength = 1;
	#tail: Promise<void> = Promise.resolve();
	protected applyToByOwner = new Map<string, ApplyTo>();
	#toClean = new Map<string, Set<string>>();
	#markers = new Map<string, Map<string, Map<string, Marker>>>();
	#delivered = new Map<string, Map<string, number>>();
	protected matches = 0;
	protected maxSeverity: Severity | undefined;
	protected listeners = new Set<(e: CollectorEvent) => void>();

	constructor(
		readonly problemMatchers: ProblemMatcher[],
		protected store: MarkerStore,
		protected host: FileHost = {}
	) {
		for (const m of problemMatchers) {
			const lm = createLineMatcher(m, host);
			this.#bufferLength = Math.max(this.#bufferLength, lm.matchLength);
			const list = this.#matchers.get(lm.matchLength) ?? [];
			list.push(lm);
			this.#matchers.set(lm.matchLength, list);
			const current = this.applyToByOwner.get(m.owner);
			this.applyToByOwner.set(m.owner, current === undefined || current === m.applyTo ? m.applyTo : 'allDocuments');
		}
	}

	onEvent(fn: (e: CollectorEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	protected fire(e: CollectorEvent) {
		for (const fn of this.listeners) fn(e);
	}

	get numberOfMatches() {
		return this.matches;
	}

	get maxMarkerSeverity() {
		return this.maxSeverity;
	}

	/** Lines are handled in order; `idle()` resolves once every line given so far is done. */
	processLine(line: string) {
		this.#tail = this.#tail.then(() => this.processLineInternal(line)).catch(() => {});
	}

	idle(): Promise<void> {
		return this.#tail;
	}

	protected abstract processLineInternal(line: string): Promise<void>;

	protected tryFindMarker(line: string): ProblemMatch | null {
		if (this.#active) {
			const result = this.#active.next(line);
			if (result) {
				this.#capture(result);
				return result;
			}
			this.#buffer = [];
			this.#active = null;
		}
		if (this.#buffer.length < this.#bufferLength) this.#buffer.push(line);
		else {
			this.#buffer.shift();
			this.#buffer.push(line);
		}
		const result = this.#tryMatchers();
		if (result) this.#buffer = [];
		return result;
	}

	#tryMatchers(): ProblemMatch | null {
		this.#active = null;
		const length = this.#buffer.length;
		for (let start = 0; start < length; start++) {
			for (const matcher of this.#matchers.get(length - start) ?? []) {
				const r = matcher.handle(this.#buffer, start);
				if (r.match) {
					this.#capture(r.match);
					if (r.continue) this.#active = matcher;
					return r.match;
				}
			}
		}
		return null;
	}

	#capture(m: ProblemMatch) {
		this.matches++;
		if (this.maxSeverity === undefined || RANK[m.marker.severity] > RANK[this.maxSeverity]) this.maxSeverity = m.marker.severity;
	}

	protected shouldApply(applyTo: ApplyTo, resource: string): boolean {
		if (applyTo === 'openDocuments') return this.store.isOpen(resource);
		if (applyTo === 'closedDocuments') return !this.store.isOpen(resource);
		return true;
	}

	#cleanSet(owner: string): Set<string> {
		let set = this.#toClean.get(owner);
		if (!set) this.#toClean.set(owner, (set = new Set()));
		return set;
	}

	protected recordResourcesToClean(owner: string) {
		const set = this.#cleanSet(owner);
		for (const r of this.store.resources(owner)) set.add(r);
	}

	protected recordResourceToClean(owner: string, resource: string) {
		this.#cleanSet(owner).add(resource);
	}

	protected removeResourceToClean(owner: string, resource: string) {
		this.#toClean.get(owner)?.delete(resource);
	}

	#clean(owner: string, toClean: Set<string>) {
		const applyTo = this.applyToByOwner.get(owner);
		const uris = [...toClean].filter((r) => applyTo === 'allDocuments' || (applyTo === 'openDocuments' && this.store.isOpen(r)) || (applyTo === 'closedDocuments' && !this.store.isOpen(r)));
		if (uris.length) this.store.remove(owner, uris);
	}

	protected cleanAllMarkers() {
		this.#toClean.forEach((set, owner) => this.#clean(owner, set));
		this.#toClean = new Map();
	}

	protected cleanMarkers(owner: string) {
		const set = this.#toClean.get(owner);
		if (set) {
			this.#clean(owner, set);
			this.#toClean.delete(owner);
		}
	}

	protected recordMarker(marker: Marker, owner: string, resource: string) {
		let perOwner = this.#markers.get(owner);
		if (!perOwner) this.#markers.set(owner, (perOwner = new Map()));
		let perResource = perOwner.get(resource);
		if (!perResource) perOwner.set(resource, (perResource = new Map()));
		const key = markerKey(marker);
		if (!perResource.has(key)) perResource.set(key, marker);
	}

	protected reportMarkers() {
		this.#markers.forEach((perOwner, owner) => perOwner.forEach((markers, resource) => this.#deliver(owner, resource, markers)));
	}

	protected deliver(owner: string, resource: string) {
		const markers = this.#markers.get(owner)?.get(resource);
		if (markers) this.#deliver(owner, resource, markers);
	}

	#deliver(owner: string, resource: string, markers: Map<string, Marker>) {
		let reported = this.#delivered.get(owner);
		if (!reported) this.#delivered.set(owner, (reported = new Map()));
		if (markers.size === reported.get(resource)) return;
		this.store.change(owner, resource, [...markers.values()]);
		reported.set(resource, markers.size);
	}

	protected cleanMarkerCaches() {
		this.matches = 0;
		this.maxSeverity = undefined;
		this.#markers.clear();
		this.#delivered.clear();
	}

	/** The task ended: report what was found and remove what this run no longer reports. */
	async done() {
		await this.idle();
		this.reportMarkers();
		this.cleanAllMarkers();
	}
}

/** A task that runs to completion (VS Code's StartStopProblemCollector). */
export class StartStopCollector extends Collector {
	#owner: string | undefined;
	#resource: string | undefined;
	#started = false;

	constructor(matchers: ProblemMatcher[], store: MarkerStore, host?: FileHost) {
		super(matchers, store, host);
		for (const owner of new Set(matchers.map((m) => m.owner))) this.recordResourcesToClean(owner);
	}

	protected async processLineInternal(line: string) {
		if (!this.#started) {
			this.#started = true;
			this.fire({ kind: 'begins' });
		}
		const match = this.tryFindMarker(line);
		if (!match) return;
		const owner = match.description.owner;
		const resource = await match.resource;
		this.removeResourceToClean(owner, resource);
		if (!this.shouldApply(match.description.applyTo, resource)) return;
		this.recordMarker(match.marker, owner, resource);
		if (this.#owner !== owner || this.#resource !== resource) {
			if (this.#owner && this.#resource) this.deliver(this.#owner, this.#resource);
			this.#owner = owner;
			this.#resource = resource;
		}
	}
}

type Background = { key: number; matcher: ProblemMatcher; begin: RegExp; beginFile?: number; end: RegExp };

/** A background task (watcher): each begins…ends cycle replaces the previous cycle's problems
 * (VS Code's WatchingProblemCollector). */
export class WatchingCollector extends Collector {
	#backgrounds: Background[] = [];
	#active = new Set<number>();
	#owner: string | undefined;
	#resource: string | undefined;

	constructor(matchers: ProblemMatcher[], store: MarkerStore, host?: FileHost) {
		super(matchers, store, host);
		matchers.forEach((m, key) => {
			if (m.watching) this.#backgrounds.push({ key, matcher: m, begin: m.watching.beginsPattern.regexp, beginFile: m.watching.beginsPattern.file, end: m.watching.endsPattern.regexp });
		});
	}

	isWatching(): boolean {
		return this.#backgrounds.length > 0;
	}

	/** Before the first line: matchers with `activeOnStart` begin right away. */
	aboutToStart() {
		for (const b of this.#backgrounds) {
			if (!b.matcher.watching?.activeOnStart) continue;
			this.#active.add(b.key);
			this.fire({ kind: 'begins' });
			this.recordResourcesToClean(b.matcher.owner);
		}
	}

	protected async processLineInternal(line: string) {
		if ((await this.#tryBegin(line)) || this.#tryFinish(line)) return;
		const match = this.tryFindMarker(line);
		if (!match) return;
		const resource = await match.resource;
		const owner = match.description.owner;
		this.removeResourceToClean(owner, resource);
		if (!this.shouldApply(match.description.applyTo, resource)) return;
		this.recordMarker(match.marker, owner, resource);
		if (this.#owner !== owner || this.#resource !== resource) {
			this.#reportCurrent();
			this.#owner = owner;
			this.#resource = resource;
		}
	}

	/** Delivers the markers of the resource being collected (VS Code does it 3 s after output stops). */
	forceDelivery() {
		this.#reportCurrent();
	}

	async #tryBegin(line: string): Promise<boolean> {
		let result = false;
		for (const b of this.#backgrounds) {
			const matches = b.begin.exec(line);
			if (!matches || this.#active.has(b.key)) continue;
			this.#active.add(b.key);
			result = true;
			this.fire({ kind: 'begins' });
			this.cleanMarkerCaches();
			this.#resetCurrent();
			const owner = b.matcher.owner;
			const file = b.beginFile !== undefined ? matches[b.beginFile] : undefined;
			if (file) this.recordResourceToClean(owner, await getResource(file, b.matcher, this.host));
			else this.recordResourcesToClean(owner);
		}
		return result;
	}

	#tryFinish(line: string): boolean {
		let result = false;
		for (const b of this.#backgrounds) {
			const matches = b.end.exec(line);
			if (!matches || !this.#active.delete(b.key)) continue;
			this.#resetCurrent();
			this.fire({ kind: 'ends', captured: matches.groups ? new Map(Object.entries(matches.groups)) : undefined });
			result = true;
			this.cleanMarkers(b.matcher.owner);
			this.cleanMarkerCaches();
		}
		return result;
	}

	#resetCurrent() {
		this.#reportCurrent();
		this.#owner = undefined;
		this.#resource = undefined;
	}

	#reportCurrent() {
		if (this.#owner && this.#resource) this.deliver(this.#owner, this.#resource);
	}

	/** Matchers still between begins and ends. */
	get activeCount() {
		return this.#active.size;
	}

	override async done() {
		await this.idle();
		for (const owner of this.applyToByOwner.keys()) this.recordResourcesToClean(owner);
		this.reportMarkers();
		this.cleanAllMarkers();
	}
}
