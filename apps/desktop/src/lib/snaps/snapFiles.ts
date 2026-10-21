// Reading a snap's files: a built-in snap's from the app bundle (lazy chunks of
// `apps/desktop/snaps/`, as the vendored themes were), a user or repo snap's through Rust
// (`snap_file_read`, which refuses a listed file that changed since it was listed).

import { invoke } from '@tauri-apps/api/core';
import type { SnapRef } from './contributions.ts';

const bundled = import.meta.glob<string>('../../../snaps/*/**/*', { query: '?raw', import: 'default' });

/** A text file of a snap; `sha256` is the hash it was listed with (files the manifest names). */
export async function readSnapText(snap: SnapRef, path: string, sha256?: string): Promise<string> {
	if (snap.source === 'builtin') {
		const load = bundled[`../../../snaps/${snap.id}/${path}`];
		if (!load) throw new Error(`${snap.id}: ${path} is not part of the app`);
		return load();
	}
	return invoke<string>('snap_file_read', { source: snap.source, id: snap.id, path, sha256: sha256 ?? null });
}

/** An image of a user or repo snap (file icon themes) as a `data:` URL. */
export function readSnapImage(snap: SnapRef, path: string): Promise<string> {
	if (snap.source === 'builtin') return Promise.reject(new Error(`${snap.id}: built-in snaps ship no icon images`));
	return invoke<string>('snap_file_data_url', { source: snap.source, id: snap.id, path });
}
