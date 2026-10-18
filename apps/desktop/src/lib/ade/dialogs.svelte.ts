// The ADE dialog shown over the window (AdeDialogs.svelte mounts it in the workbench), so the
// IDE's task tab and the Agents layout open the same forms.

export type AdeDialogKind = { kind: 'pr'; slug: string } | { kind: 'remove'; slug: string };

class AdeDialogs {
	current = $state<AdeDialogKind | null>(null);

	open(d: AdeDialogKind) {
		this.current = d;
	}

	close() {
		this.current = null;
	}
}

export const adeDialogs = new AdeDialogs();
