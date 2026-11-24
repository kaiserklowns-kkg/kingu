/**
 * Loading a file into a group's Monaco editor (EditorHost). The load is async, so by the time it
 * resolves the tab may have changed or the editor may be gone: a group's EditorHost is recreated
 * when the group is maximized or restored, when the grid first splits, and on a dev hot reload.
 * A gone editor must neither show the model (Monaco throws "InstantiationService has been
 * disposed" on a disposed editor) nor report that error as the file's, because the error
 * placeholder is kept per path and would then cover the same file in the editor that replaced it.
 */

export type OpenResult = 'shown' | 'stale' | 'failed';

export interface OpenPorts<E extends { model: { isDisposed(): boolean } }> {
	/** Reads the file into its shared text model. */
	load: () => Promise<E>;
	/** False once this editor is disposed or replaced. */
	alive: () => boolean;
	/** Whether the group still shows the path being loaded. */
	wanted: () => boolean;
	/** Sets the model on the editor. */
	show: (entry: E) => void;
	/** The file cannot be opened: VS Code keeps the tab and shows why. */
	failed: (e: unknown) => void;
}

export async function openInEditor<E extends { model: { isDisposed(): boolean } }>(o: OpenPorts<E>): Promise<OpenResult> {
	let entry: E;
	try {
		entry = await o.load();
	} catch (e) {
		// A failed read is the file's own (binary, too large, unreadable), whichever editor asked.
		o.failed(e);
		return 'failed';
	}
	if (!o.alive() || !o.wanted() || entry.model.isDisposed()) return 'stale';
	try {
		o.show(entry);
	} catch (e) {
		o.failed(e);
		return 'failed';
	}
	return 'shown';
}
