// Dictation audio: the microphone's float samples as the 16 kHz 16-bit mono WAV that whisper.cpp
// and OpenAI take (Rust voice.rs checks it again). Pure, so it is tested without a microphone.

export const SAMPLE_RATE = 16_000;
/** Longest recording, as voice.rs (MAX_MINUTES). */
export const MAX_SECONDS = 5 * 60;

/** The chunks one after the other. */
export function concat(chunks: readonly Float32Array[]): Float32Array {
	const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

/** `samples` at `from` Hz as `to` Hz: an average over each output step when shrinking, linear between neighbours when growing. */
export function resample(samples: Float32Array, from: number, to = SAMPLE_RATE): Float32Array {
	if (from === to || samples.length === 0) return samples.slice();
	const ratio = from / to;
	const out = new Float32Array(Math.floor(samples.length / ratio));
	for (let i = 0; i < out.length; i++) {
		const start = i * ratio;
		if (ratio > 1) {
			const end = Math.min(samples.length, Math.floor(start + ratio));
			let sum = 0;
			for (let j = Math.floor(start); j < end; j++) sum += samples[j];
			out[i] = sum / Math.max(1, end - Math.floor(start));
		} else {
			const j = Math.floor(start);
			const f = start - j;
			out[i] = samples[j] * (1 - f) + (samples[j + 1] ?? samples[j]) * f;
		}
	}
	return out;
}

/** 16-bit PCM mono WAV of `samples` (clamped to −1…1). */
export function encodeWav(samples: Float32Array, rate = SAMPLE_RATE): Uint8Array {
	const bytes = new Uint8Array(44 + samples.length * 2);
	const v = new DataView(bytes.buffer);
	const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
	text(0, 'RIFF');
	v.setUint32(4, 36 + samples.length * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	text(36, 'data');
	v.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
	}
	return bytes;
}

/** Base64 of `bytes`, in chunks (one call per byte would overflow the argument list). */
export function toBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

/** The loudest sample's level 0–1 (the indicator's meter). */
export function level(samples: Float32Array): number {
	let peak = 0;
	for (const s of samples) peak = Math.max(peak, Math.abs(s));
	return Math.min(1, peak);
}
