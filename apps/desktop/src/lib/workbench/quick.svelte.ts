// Quick input state (VS Code: IQuickInputService / quick access). The prefix picks the provider:
// '>' commands, ':' go to line, '' files.
class Quick {
	visible = $state(false);
	value = $state('');

	show(prefix = '') {
		this.value = prefix;
		this.visible = true;
	}

	hide() {
		this.visible = false;
	}
}

export const quick = new Quick();
