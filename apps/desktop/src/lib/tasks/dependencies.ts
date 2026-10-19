// dependsOn (VS Code: terminalTaskSystem.ts _executeTask / _executeDependencyTask /
// _getDependencyPromise): dependencies run before the task, in parallel or in `sequence` (which
// stops at the first failure), each task once per run even when several depend on it, a cycle is
// reported and fails the task, and a background dependency counts as done once its watcher goes
// inactive (its first endsPattern), not when it exits. Generic over the task type so the order can
// be tested without terminals.

/** A task's result: its exit code, undefined when it was terminated or did not run. */
export type Summary = { exitCode?: number };

/** A started task: `done` on exit, `inactive` when a background task's watcher first went idle. */
export type Execution = { done: Promise<Summary>; inactive?: Promise<Summary> };

export type GraphHost<T, R> = {
	key(task: T): string;
	dependsOn(task: T): R[];
	sequence(task: T): boolean;
	isBackground(task: T): boolean;
	hasCommand(task: T): boolean;
	resolve(ref: R): T | undefined;
	/** Starts the task's own command (its dependencies are done). */
	execute(task: T): Execution;
	/** The running instance of `task`, if it already runs (it is then not started again). */
	running(task: T): Execution | undefined;
	/** The Tasks output channel (cycles, unknown dependencies). */
	log(message: string): void;
	/** A dependency is starting (VS Code's DependsOnStarted event). */
	dependsOnStarted?(task: T): void;
};

/** A background dependency is done when it goes inactive, else when it exits. */
function dependencyPromise<T, R>(host: GraphHost<T, R>, task: T, exec: Execution): Promise<Summary> {
	if (!host.isBackground(task) || !exec.inactive) return exec.done;
	return Promise.race([exec.inactive, exec.done]);
}

/**
 * Runs `task` after its dependencies; resolves with the task's own summary (or the first failing
 * dependency's). `untilInactive`: a background task counts as done once its watcher goes idle
 * (a debug preLaunchTask), as its dependents see it.
 */
export function runTask<T, R>(host: GraphHost<T, R>, task: T, opts: { untilInactive?: boolean } = {}): Promise<Summary> {
	return execute(host, task, new Set(), new Map(), !!opts.untilInactive);
}

async function execute<T, R>(host: GraphHost<T, R>, task: T, live: Set<string>, encountered: Map<string, Promise<Summary>>, asDependency: boolean): Promise<Summary> {
	const promises: Promise<Summary>[] = [];
	const deps = host.dependsOn(task);
	if (deps.length) {
		const nextLive = new Set(live).add(host.key(task));
		for (const ref of deps) {
			const dep = host.resolve(ref);
			if (!dep) {
				host.log(`Couldn't resolve dependent task '${typeof ref === 'string' ? ref : JSON.stringify(ref)}' in workspace folder`);
				continue;
			}
			const key = host.key(dep);
			let result: Promise<Summary> | undefined;
			if (nextLive.has(key)) {
				host.log(`There is a dependency cycle. See task "${key}".`);
				result = Promise.resolve({});
			} else {
				result = encountered.get(key);
				if (!result) {
					const running = host.running(dep);
					if (running) result = dependencyPromise(host, dep, running);
				}
			}
			if (!result) {
				host.dependsOnStarted?.(task);
				// A background dependency is done once it goes inactive, not when it exits.
				result = execute(host, dep, nextLive, encountered, true);
			}
			encountered.set(key, result);
			promises.push(result);
			if (host.sequence(task)) {
				const r = await result;
				if (r.exitCode !== 0) break;
			}
		}
	}
	const summaries = await Promise.all(promises);
	for (const s of summaries) if (s.exitCode !== 0) return { exitCode: s.exitCode };
	if (!host.hasCommand(task)) return { exitCode: 0 };
	const exec = host.execute(task);
	return asDependency ? dependencyPromise(host, task, exec) : exec.done;
}
