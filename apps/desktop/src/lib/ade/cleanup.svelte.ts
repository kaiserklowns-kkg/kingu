// Clean Up Tasks (Orca's WorkspaceCleanupDialog): which tasks to remove in one go.
class Cleanup {
	open = $state(false);
	/** Only these tasks, all checked (Pick winner offers the other attempts); null: every task. */
	only = $state<string[] | null>(null);

	/** The dialog with just `slugs` (the losing attempts of a best-of-N group). */
	offer(slugs: string[]) {
		this.only = slugs;
		this.open = true;
	}

	close() {
		this.open = false;
		this.only = null;
	}
}

export const cleanup = new Cleanup();
