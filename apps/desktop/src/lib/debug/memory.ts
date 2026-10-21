// The Memory view (VS Code: View Binary Data, the hex editor over a variable's memoryReference):
// bytes read with readMemory shown 16 to a row as address, hex and text; an edited byte is written
// back with writeMemory. Pure, so the paging, rows and the edit parsing are unit-tested;
// MemoryView.svelte reads, draws and writes.

import { formatAddress, parseAddress } from './disassembly.ts';

export const ROW_BYTES = 16;
/** How much one readMemory request asks for. */
export const MEMORY_PAGE = 1024;

/** A read range: `offset` from the memory reference, the bytes read and how many after them could not be. */
export type MemoryChunk = { offset: number; bytes: Uint8Array; unreadable: number };

/** One row: its offset from the reference, its address, and each byte (null: unreadable or not read). */
export type MemoryRow = { offset: number; address: string; bytes: (number | null)[] };

/** The address `offset` bytes from `base` (a `0x…` reference), or `base+offset` when base is not a number. */
export function addressAt(base: string, offset: number): string {
	const at = parseAddress(base);
	if (at === null) return offset ? `${base}+${offset}` : base;
	const n = at + BigInt(offset);
	return formatAddress(n < 0n ? 0n : n, 8);
}

/** The rows from `from` to `to` (offsets, row aligned) over the chunks read so far. */
export function memoryRows(base: string, chunks: readonly MemoryChunk[], from: number, to: number): MemoryRow[] {
	const start = Math.floor(from / ROW_BYTES) * ROW_BYTES;
	const rows: MemoryRow[] = [];
	for (let off = start; off < to; off += ROW_BYTES) {
		const bytes: (number | null)[] = [];
		for (let i = 0; i < ROW_BYTES; i++) bytes.push(byteAt(chunks, off + i));
		rows.push({ offset: off, address: addressAt(base, off), bytes });
	}
	return rows;
}

/** The byte at an offset, or null when no chunk has it readable. */
export function byteAt(chunks: readonly MemoryChunk[], offset: number): number | null {
	for (const c of chunks) {
		const i = offset - c.offset;
		if (i >= 0 && i < c.bytes.length) return c.bytes[i];
	}
	return null;
}

/** Whether `[offset, offset + count)` is already covered by the chunks (readable or known unreadable). */
export function isRead(chunks: readonly MemoryChunk[], offset: number, count: number): boolean {
	for (let o = offset; o < offset + count; ) {
		const c = chunks.find((x) => o >= x.offset && o < x.offset + x.bytes.length + x.unreadable);
		if (!c) return false;
		o = c.offset + c.bytes.length + c.unreadable;
	}
	return true;
}

/** A chunk written into the list (a write, a re-read after a `memory` event): newer bytes win. */
export function putChunk(chunks: readonly MemoryChunk[], chunk: MemoryChunk): MemoryChunk[] {
	const end = chunk.offset + chunk.bytes.length + chunk.unreadable;
	const kept = chunks.filter((c) => c.offset + c.bytes.length + c.unreadable <= chunk.offset || c.offset >= end);
	return [...kept, chunk].sort((a, b) => a.offset - b.offset);
}

export const hexByte = (b: number | null) => (b === null ? '??' : b.toString(16).padStart(2, '0'));

/** The text column: printable ASCII as itself, the rest as `.` (unreadable: a space). */
export const asciiOf = (bytes: readonly (number | null)[]) => bytes.map((b) => (b === null ? ' ' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');

/** An edit typed into a byte (`ff`, `0x1f`, `de ad be ef`): the bytes, or null when it is not hex bytes. */
export function parseHexBytes(input: string): Uint8Array | null {
	const parts = input.trim().replace(/0x/gi, ' ').split(/[\s,]+/).filter(Boolean);
	if (!parts.length) return null;
	const out: number[] = [];
	for (const p of parts) {
		// `dead` is two bytes; an odd length gets a leading zero (`f` is 0x0f).
		const hex = p.length % 2 ? `0${p}` : p;
		if (!/^[0-9a-f]+$/i.test(hex)) return null;
		for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
	}
	return Uint8Array.from(out);
}

/** The Memory editor's key: one per session and memory reference. */
export const MEMORY_PREFIX = 'debug-memory:';
export const memoryKey = (session: number, memoryReference: string) => `${MEMORY_PREFIX}${session}/${encodeURIComponent(memoryReference)}`;
export const isMemoryKey = (key: string) => key.startsWith(MEMORY_PREFIX);
export function parseMemoryKey(key: string): { session: number; memoryReference: string } | null {
	const m = /^debug-memory:(\d+)\/(.+)$/.exec(key);
	return m ? { session: Number(m[1]), memoryReference: decodeURIComponent(m[2]) } : null;
}

/** The Disassembly view's editor key (VS Code has one Disassembly editor). */
export const DISASSEMBLY_KEY = 'debug-disassembly:';
export const isDisassemblyKey = (key: string) => key === DISASSEMBLY_KEY;
/** Either debug editor (no text model, nothing restored from disk). */
export const isDebugEditorKey = (key: string) => isMemoryKey(key) || isDisassemblyKey(key);
