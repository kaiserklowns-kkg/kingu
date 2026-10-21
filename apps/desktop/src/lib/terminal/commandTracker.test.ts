import { describe, expect, test } from 'bun:test';
import { ago, CommandTracker, commandLine, navigate, navigationLines, outputRange, stickyCommand, type Mark, type TerminalCommand } from './commandTracker.ts';
import { parseOsc633 } from './shellIntegration.ts';

/** A fake buffer: the cursor's line and column, and markers that can be scrolled away. */
class FakeTerm {
	line = 0;
	x = 0;
	marks: FakeMark[] = [];
	typed = new Map<number, string>();
	host = {
		mark: () => {
			const m = new FakeMark(this.line);
			this.marks.push(m);
			return m;
		},
		cursorX: () => this.x,
		textBetween: (from: FakeMark, x: number) => (this.typed.get(from.line) ?? '').slice(x),
		now: () => 1000
	};
	/** Drops the first `n` lines from the scrollback. */
	trim(n: number) {
		for (const m of this.marks) {
			if (m.isDisposed) continue;
			if (m.line < n) m.dispose();
			else m.line -= n;
		}
		this.line -= n;
	}
}

class FakeMark implements Mark {
	isDisposed = false;
	constructor(public line: number) {}
	dispose() {
		this.isDisposed = true;
		this.line = -1;
	}
}

/** Runs a session: `[line, x, osc]` steps. */
function run(steps: [number, number, string][], term = new FakeTerm()) {
	const tracker = new CommandTracker(term.host);
	for (const [line, x, osc] of steps) {
		term.line = line;
		term.x = x;
		const e = parseOsc633(osc);
		if (e) tracker.handle(e);
	}
	return { tracker, term };
}

describe('command detection', () => {
	test('A B E C D make a command with its marks, exit code and cwd', () => {
		const { tracker } = run([
			[0, 0, 'P;Cwd=/repo'],
			[0, 0, 'A'],
			[0, 2, 'B'],
			[0, 9, 'E;ls -la'],
			[1, 0, 'C'],
			[5, 0, 'D;0'],
			[5, 0, 'A']
		]);
		expect(tracker.commands).toHaveLength(1);
		const c = tracker.commands[0];
		expect(c.command).toBe('ls -la');
		expect(c.exitCode).toBe(0);
		expect(c.cwd).toBe('/repo');
		expect([c.promptStart!.line, c.commandStart!.line, c.executed!.line, c.end!.line]).toEqual([0, 0, 1, 5]);
		expect(commandLine(c)).toBe(0);
		expect(outputRange(c)).toEqual({ start: 1, end: 4 });
		expect(tracker.current?.promptStart?.line).toBe(5);
		expect(tracker.active).toBe(true);
	});

	test('without E the command line is read from the buffer between B and C', () => {
		const term = new FakeTerm();
		term.typed.set(0, '$ git status  ');
		const { tracker } = run([[0, 0, 'A'], [0, 2, 'B'], [1, 0, 'C'], [3, 0, 'D;1']], term);
		expect(tracker.commands[0].command).toBe('git status');
		expect(tracker.commands[0].exitCode).toBe(1);
	});

	test('an empty line or the first prompt makes no command', () => {
		const { tracker, term } = run([[0, 0, 'D'], [0, 0, 'A'], [0, 2, 'B'], [1, 0, 'D'], [1, 0, 'A'], [1, 2, 'B']]);
		expect(tracker.commands).toEqual([]);
		// The abandoned prompt's markers were let go.
		expect(term.marks.filter((m) => !m.isDisposed)).toHaveLength(2);
	});

	test('a prompt redrawn before running replaces the pending one', () => {
		const { tracker } = run([[0, 0, 'A'], [0, 2, 'B'], [2, 0, 'A'], [2, 2, 'B'], [2, 4, 'E;make'], [3, 0, 'C'], [4, 0, 'D;2']]);
		expect(tracker.commands).toHaveLength(1);
		expect(tracker.commands[0].promptStart!.line).toBe(2);
		expect(tracker.commands[0].exitCode).toBe(2);
	});

	test('a prompt after output without D ends that command with no exit code', () => {
		const { tracker } = run([[0, 0, 'A'], [0, 2, 'B'], [0, 2, 'E;sleep 1'], [1, 0, 'C'], [2, 0, 'A']]);
		expect(tracker.commands).toHaveLength(1);
		expect(tracker.commands[0].exitCode).toBeUndefined();
		expect(tracker.commands[0].end!.line).toBe(2);
	});

	test('finished listeners, running command and last()', () => {
		const term = new FakeTerm();
		const tracker = new CommandTracker(term.host);
		const seen: string[] = [];
		const off = tracker.onFinished((c) => seen.push(c.command));
		for (const [line, osc] of [[0, 'A'], [0, 'B'], [0, 'E;one'], [1, 'C'], [2, 'D;0'], [2, 'A'], [2, 'B'], [2, 'E;two'], [3, 'C']] as const) {
			term.line = line;
			tracker.handle(parseOsc633(osc)!);
		}
		expect(seen).toEqual(['one']);
		expect(tracker.all().map((c) => c.command)).toEqual(['one', 'two']);
		expect(tracker.last()?.command).toBe('one');
		off();
		term.line = 4;
		tracker.handle({ type: 'finished', exitCode: 0 });
		expect(seen).toEqual(['one']);
		expect(tracker.last()?.command).toBe('two');
	});

	test('directories are recorded once, most recent last; the shell property', () => {
		const { tracker } = run([[0, 0, 'P;Cwd=/a'], [0, 0, 'P;Cwd=/b'], [0, 0, 'P;Cwd=/a'], [0, 0, 'P;Shell=fish']]);
		expect(tracker.directories).toEqual(['/b', '/a']);
		expect(tracker.cwd).toBe('/a');
		expect(tracker.shell).toBe('fish');
	});

	test('marks (OSC 1337 SetMark) are navigation stops, not commands', () => {
		const term = new FakeTerm();
		const tracker = new CommandTracker(term.host);
		term.line = 7;
		tracker.handle({ type: 'mark' });
		expect(tracker.commands[0].kind).toBe('mark');
		expect(tracker.last()).toBeUndefined();
		expect(navigationLines(tracker.commands)).toEqual([7]);
	});

	test('commands whose lines left the scrollback are pruned', () => {
		const { tracker, term } = run([
			[0, 0, 'A'], [0, 2, 'B'], [0, 2, 'E;a'], [1, 0, 'C'], [3, 0, 'D;0'],
			[3, 0, 'A'], [3, 2, 'B'], [3, 2, 'E;b'], [4, 0, 'C'], [6, 0, 'D;0']
		]);
		term.trim(2);
		tracker.prune();
		expect(tracker.commands.map((c) => c.command)).toEqual(['b']);
		expect(commandLine(tracker.commands[0])).toBe(1);
	});

	test('at() finds the command owning a line', () => {
		const { tracker } = run([
			[0, 0, 'P;Cwd=/one'], [0, 0, 'A'], [0, 2, 'B'], [0, 2, 'E;a'], [1, 0, 'C'], [3, 0, 'D;0'],
			[3, 0, 'P;Cwd=/two'], [3, 0, 'A'], [3, 2, 'B'], [3, 2, 'E;b'], [4, 0, 'C']
		]);
		expect(tracker.at(2)?.command).toBe('a');
		expect(tracker.at(2)?.cwd).toBe('/one');
		expect(tracker.at(5)?.command).toBe('b');
		expect(tracker.at(5)?.cwd).toBe('/two');
	});

	test('dispose lets every marker go', () => {
		const { tracker, term } = run([[0, 0, 'A'], [0, 2, 'B'], [1, 0, 'C'], [2, 0, 'D;0'], [2, 0, 'A']]);
		tracker.dispose();
		expect(term.marks.every((m) => m.isDisposed)).toBe(true);
	});
});

describe('navigation and sticky scroll', () => {
	test('previous and next stops', () => {
		const lines = [2, 10, 30];
		expect(navigate(lines, 40, -1)).toBe(30);
		expect(navigate(lines, 30, -1)).toBe(10);
		expect(navigate(lines, 2, -1)).toBeNull();
		expect(navigate(lines, 2, 1)).toBe(10);
		expect(navigate(lines, 30, 1)).toBeNull();
		expect(navigate([], 5, -1)).toBeNull();
	});

	const cmd = (id: number, start: number, end: number | undefined, command: string): TerminalCommand<FakeMark> => ({
		id,
		kind: 'command',
		command,
		promptStart: new FakeMark(start),
		executed: new FakeMark(start + 1),
		...(end !== undefined ? { end: new FakeMark(end) } : {})
	});

	test('the sticky command is the one whose output crosses the top line', () => {
		const list = [cmd(1, 0, 5, 'ls'), cmd(2, 5, 50, 'npm test'), cmd(3, 50, undefined, 'claude')];
		expect(stickyCommand(list, 3)?.command).toBe('ls');
		expect(stickyCommand(list, 20)?.command).toBe('npm test');
		// Its own prompt line is in view: nothing sticks.
		expect(stickyCommand(list, 5)).toBeUndefined();
		// A running command sticks until it ends, unless it is ignored.
		expect(stickyCommand(list, 80)?.command).toBe('claude');
		expect(stickyCommand(list, 80, ['clear'])?.command).toBe('claude');
		expect(stickyCommand(list, 80, ['claude'])).toBeUndefined();
		expect(stickyCommand([], 10)).toBeUndefined();
	});

	test('outputRange of an empty output', () => {
		expect(outputRange(cmd(1, 0, 1, 'true'))).toBeNull();
		expect(outputRange(cmd(1, 0, 3, 'echo'))).toEqual({ start: 1, end: 2 });
	});

	test('ago units', () => {
		expect(ago(0, 30_000)).toEqual({ unit: 'second', count: 30 });
		expect(ago(0, 5 * 60_000)).toEqual({ unit: 'minute', count: 5 });
		expect(ago(0, 3 * 3600_000)).toEqual({ unit: 'hour', count: 3 });
		expect(ago(0, 2 * 86400_000)).toEqual({ unit: 'day', count: 2 });
		expect(ago(10, 0)).toEqual({ unit: 'second', count: 0 });
	});
});
