// Transient status bar message (VS Code: IStatusbarService / window.setStatusBarMessage).
// `error` / `warning` also go to the notification center (a toast, and the bell's list).
import { notifications } from './notifications.svelte';

class Status {
	message = $state('');
	branch = $state<string | null>(null);
	#timer: ReturnType<typeof setTimeout> | undefined;

	flash(message: string, ms = 5000) {
		this.message = message;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => (this.message = ''), ms);
	}

	error(message: string, ms = 8000) {
		this.flash(message, ms);
		notifications.push(message, 'error');
	}

	warning(message: string, ms = 8000) {
		this.flash(message, ms);
		notifications.push(message, 'warning');
	}
}

export const status = new Status();
