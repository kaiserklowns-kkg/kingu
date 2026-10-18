// Commit message drafts per worktree, kept while the window is open (Orca keeps them in memory
// so switching worktrees or tabs does not lose a half-written message). Keyed by folder too, so
// one folder's draft for its main worktree never shows up in another folder.
export const drafts = new Map<string, string>();

export const draftKey = (root: string | null, key: string) => `${root ?? ''}\u0000${key}`;
