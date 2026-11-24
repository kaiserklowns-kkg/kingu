// Reads every process's launch environment the way any program can, also under Seatbelt
// (`sysctl` KERN_PROCARGS2, what `ps -E` uses; /bin/ps itself is setuid and refused by the
// sandbox), and prints how many hold the text in the file given as the argument. macOS only.
// The text comes from a file so that no command line carries it.

import { dlopen, FFIType, ptr } from 'bun:ffi';
import { readFileSync } from 'node:fs';

const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;

const libc = dlopen('/usr/lib/libSystem.B.dylib', {
	sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
	proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 }
});

const needle = readFileSync(process.argv[2]!, 'utf8').trim();
const pids = new Int32Array(16384);
const n = libc.symbols.proc_listallpids(ptr(pids), pids.byteLength);
const buf = new Uint8Array(1 << 20);
const size = new BigUint64Array(1);
let hits = 0;
for (const pid of pids.subarray(0, Math.max(0, n))) {
	if (pid <= 0 || pid === process.pid) continue;
	const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
	size[0] = BigInt(buf.byteLength);
	if (libc.symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null, 0) !== 0) continue;
	const len = Number(size[0]);
	const argc = new DataView(buf.buffer).getInt32(0, true);
	// argc, the executable path, padding, argv, then the environment.
	const parts = Buffer.from(buf.subarray(4, len)).toString('latin1').split('\0');
	let i = 1;
	while (i < parts.length && parts[i] === '') i++;
	const env = parts.slice(i + argc).join('\n');
	if (env.includes(needle)) hits++;
}
console.log(hits);
