// The Disassembly view (VS Code: disassemblyView.ts): the instructions around the stopped frame's
// instruction pointer, more fetched as it scrolls, the source lines they came from between them
// (`debug.disassemblyView.showSourceCode`), and instruction breakpoints by address. Pure, so the
// merging, rows and breakpoints are unit-tested; DisassemblyView.svelte fetches and draws.

import type { DisassembledInstruction, InstructionBreakpoint } from './protocol.ts';

/** How many instructions one disassemble request asks for (VS Code asks 50 at a time). */
export const PAGE = 50;

/** An address as a number: `0x…` hex or decimal; null when it is neither. */
export function parseAddress(address: string): bigint | null {
	const a = address.trim();
	try {
		if (/^0x[0-9a-f]+$/i.test(a)) return BigInt(a);
		if (/^\d+$/.test(a)) return BigInt(a);
	} catch {
		// Not a number.
	}
	return null;
}

/** `0x` and at least `width` hex digits, the way VS Code pads the address column. */
export function formatAddress(address: bigint, width = 16): string {
	return `0x${address.toString(16).padStart(width, '0')}`;
}

/** Instructions from another request merged in, one per address, in address order; adapters pad
 * outside readable memory with `invalid` instructions, which a real one replaces. */
export function mergeInstructions(existing: readonly DisassembledInstruction[], incoming: readonly DisassembledInstruction[]): DisassembledInstruction[] {
	const byAddress = new Map<string, { at: bigint; ins: DisassembledInstruction }>();
	for (const ins of [...existing, ...incoming]) {
		const at = parseAddress(ins.address);
		if (at === null) continue;
		const key = at.toString();
		const had = byAddress.get(key);
		if (had && ins.presentationHint === 'invalid' && had.ins.presentationHint !== 'invalid') continue;
		byAddress.set(key, { at, ins });
	}
	return [...byAddress.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((x) => x.ins);
}

/** Whether an address is the same as another (`0x10` and `16`). */
export function sameAddress(a: string, b: string): boolean {
	const x = parseAddress(a);
	const y = parseAddress(b);
	return x !== null && y !== null ? x === y : a === b;
}

/** The index of an address in the instructions, or -1. */
export function indexOfAddress(list: readonly DisassembledInstruction[], address: string): number {
	return list.findIndex((i) => sameAddress(i.address, address));
}

export type DisassemblyRow =
	| { kind: 'source'; key: string; path: string; line: number; endLine: number }
	| { kind: 'instruction'; key: string; ins: DisassembledInstruction; current: boolean };

/**
 * The view's rows: each instruction, and with `showSource` a source row before the first
 * instruction of each new source line (an adapter sends `location` only when it changes, like
 * VS Code reads it, so the last one carries over).
 */
export function disassemblyRows(list: readonly DisassembledInstruction[], current: string | null, showSource: boolean): DisassemblyRow[] {
	const rows: DisassemblyRow[] = [];
	let path: string | null = null;
	let last = '';
	for (const ins of list) {
		if (ins.location?.path) path = ins.location.path;
		if (showSource && path && ins.line !== undefined) {
			const at = `${path}:${ins.line}`;
			if (at !== last) {
				rows.push({ kind: 'source', key: `s:${ins.address}`, path, line: ins.line, endLine: Math.max(ins.line, ins.endLine ?? ins.line) });
				last = at;
			}
		}
		rows.push({ kind: 'instruction', key: ins.address, ins, current: current !== null && sameAddress(ins.address, current) });
	}
	return rows;
}

// --- Instruction breakpoints ------------------------------------------------------------------

export type InstructionBreakpointSpec = { address: string; enabled: boolean };

/** A click on an instruction's breakpoint column: added, or removed when there is one. */
export function toggleInstructionBreakpoint(list: readonly InstructionBreakpointSpec[], address: string): InstructionBreakpointSpec[] {
	return list.some((b) => sameAddress(b.address, address)) ? list.filter((b) => !sameAddress(b.address, address)) : [...list, { address, enabled: true }];
}

export function setInstructionBreakpointEnabled(list: readonly InstructionBreakpointSpec[], address: string, enabled: boolean): InstructionBreakpointSpec[] {
	return list.map((b) => (sameAddress(b.address, address) ? { ...b, enabled } : b));
}

/** What setInstructionBreakpoints sends: the enabled ones by address (none while deactivated). */
export const instructionBreakpoints = (list: readonly InstructionBreakpointSpec[], activated = true): InstructionBreakpoint[] =>
	activated ? list.filter((b) => b.enabled).map((b) => ({ instructionReference: b.address, offset: 0 })) : [];

/** The instruction bytes split for display (`48 89 e5`). */
export const formatBytes = (bytes: string | undefined) => (bytes ?? '').replace(/\s+/g, '').replace(/(..)(?=.)/g, '$1 ').toLowerCase();
