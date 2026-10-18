// The system settings page: one page for the IDE and the ADE, opened over the content area in
// either mode (⌘, or the gear in the title bar), so changing a setting never switches modes.

class SystemSettings {
	visible = $state(false);
	/** The table of contents selection: a settings group, or `null` for all. */
	group = $state<string | null>(null);
	/** The Snaps management view instead of the settings editor. */
	snaps = $state(false);
	/** One snap's details (`<source>/<id>`) in the Snaps view, or `null` for all of them. */
	snapKey = $state<string | null>(null);
	/** The AI accounts view (Manage Accounts) instead of the settings editor. */
	accounts = $state(false);

	show(group: string | null = null) {
		this.group = group;
		this.snaps = false;
		this.snapKey = null;
		this.accounts = false;
		this.visible = true;
	}

	showSnaps(snapKey: string | null = null) {
		this.group = null;
		this.snaps = true;
		this.snapKey = snapKey;
		this.accounts = false;
		this.visible = true;
	}

	showAccounts() {
		this.group = null;
		this.snaps = false;
		this.snapKey = null;
		this.accounts = true;
		this.visible = true;
	}

	close() {
		this.visible = false;
	}

	toggle() {
		if (this.visible) this.close();
		else this.show();
	}
}

export const systemSettings = new SystemSettings();
