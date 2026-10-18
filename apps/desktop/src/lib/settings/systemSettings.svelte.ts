// The system settings page: one page for the IDE and the ADE, opened over the content area in
// either mode (⌘, or the gear in the title bar), so changing a setting never switches modes.

export type SettingsPageId = 'appearance' | 'arkai' | 'terminal' | 'account' | 'usage' | 'shortcuts' | 'about';

class SystemSettings {
	visible = $state(false);
	/** The table of contents selection: a settings group, or `null` for all. */
	group = $state<string | null>(null);
	/** The Snaps management view instead of the settings editor. */
	snaps = $state(false);
	/** A dedicated page instead of the settings editor (Orca's settings panes). */
	page = $state<SettingsPageId | null>(null);

	show(group: string | null = null) {
		this.group = group;
		this.snaps = false;
		this.page = null;
		this.visible = true;
	}

	showSnaps() {
		this.group = null;
		this.snaps = true;
		this.page = null;
		this.visible = true;
	}

	showPage(page: SettingsPageId) {
		this.group = null;
		this.snaps = false;
		this.page = page;
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
