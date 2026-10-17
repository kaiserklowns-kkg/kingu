// Transient status bar message (VS Code: IStatusbarService / window.setStatusBarMessage).
class Status {
	message = $state('');
	branch = $state<string | null>(null);
	#timer: ReturnType<typeof setTimeout> | undefined;

	flash(message: string, ms = 5000) {
		this.message = message;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => (this.message = ''), ms);
	}
}

export const status = new Status();
