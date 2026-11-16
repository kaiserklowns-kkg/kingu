// Orca 1.4.259's cleanup run/report limits, ported from the installed app.asar
// (`out/shared/workspace-cleanup/workspace-cleanup-run.js`).

import type { WorkspaceCleanupKeepCause } from './workspaceCleanupEvaluation';

/** Workspaces no rule watches are not part of a run's receipt. */
export const WORKSPACE_CLEANUP_UNWATCHED_CAUSES = new Set<WorkspaceCleanupKeepCause>(['not-removable', 'project-off', 'rules-off']);

export const WORKSPACE_CLEANUP_REPORT_RUN_LIMIT = 20;
// A run over hundreds of workspaces must not bloat the sidecar.
export const WORKSPACE_CLEANUP_REPORT_ROW_LIMIT = 200;
/** Evidence the run already read, kept so a row can say which PR or which files; older runs lack it. */
export const WORKSPACE_CLEANUP_ROW_IGNORED_FILE_LIMIT = 3;
