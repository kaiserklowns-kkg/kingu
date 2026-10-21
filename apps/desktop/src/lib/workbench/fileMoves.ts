// Files and folders renamed or moved in the workbench (VS Code: IWorkspaceFileService
// onDidRunWorkspaceFileOperation), after the move is done on disk. Markdown link updates listen.
// Moves of one drag (the Explorer moves them one by one) reach listeners as one batch.

export type FileMove = { from: string; to: string };

const BATCH_MS = 300;
const listeners = new Set<(moves: FileMove[]) => void>();
let pending: FileMove[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

export function onDidMoveFiles(listener: (moves: FileMove[]) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function fireDidMoveFiles(moves: FileMove[]) {
	if (!moves.length) return;
	pending.push(...moves);
	clearTimeout(timer);
	timer = setTimeout(() => {
		const batch = pending;
		pending = [];
		for (const l of listeners) l(batch);
	}, BATCH_MS);
}
