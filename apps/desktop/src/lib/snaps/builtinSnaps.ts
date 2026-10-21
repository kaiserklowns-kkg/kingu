// The snaps that ship with the app (src-tauri/src/snap_builtin.rs): rust-analyzer and the color
// themes. `builtinSnaps.json` is written by a Rust test from `apps/desktop/snaps/` and checked to
// be current, so the webview has them before (and without) `snap_list`.

import data from './builtinSnaps.json';
import type { SnapInfo } from './snapModel.ts';

export const BUILTIN_SNAPS: readonly SnapInfo[] = data as unknown as SnapInfo[];
