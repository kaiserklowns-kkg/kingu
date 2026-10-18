// In-window dialogs (VS Code's dialog service, Orca's confirm dialogs) instead of the OS's message
// boxes, so confirmations look like the rest of Kingu on every OS. `ask` and `message` take the same
// arguments as @tauri-apps/plugin-dialog's, so call sites only change their import.

export type DialogKind = 'info' | 'warning' | 'error';
export type DialogOptions = { title?: string; kind?: DialogKind; okLabel?: string; cancelLabel?: string };
/** An extra choice under the message (Orca's "also delete the branch"). */
export type DialogCheckbox = { label: string; checked?: boolean };
type Request = DialogOptions & { message: string; cancellable: boolean; checkbox?: DialogCheckbox & { checked: boolean }; input?: { value: string; placeholder?: string }; resolve: (ok: boolean, shown: Request) => void };

class Dialogs {
	current = $state<Request | null>(null);
	#queue: Request[] = [];

	#open(r: Request) {
		if (this.current) this.#queue.push(r);
		else this.current = r;
	}

	settle(ok: boolean) {
		const r = this.current;
		if (!r) return;
		this.current = this.#queue.shift() ?? null;
		// `r` is the state proxy the dialog bound its checkbox to, so it holds what the user chose.
		r.resolve(ok, r);
	}

	ask(message: string, options: DialogOptions | string = {}): Promise<boolean> {
		const opts = typeof options === 'string' ? { title: options } : options;
		return new Promise((resolve) => this.#open({ ...opts, message, cancellable: true, resolve }));
	}

	/** Like `ask`, with a checkbox: resolves `{ ok, checked }`. */
	confirm(message: string, options: DialogOptions & { checkbox: DialogCheckbox }): Promise<{ ok: boolean; checked: boolean }> {
		const checkbox = { ...options.checkbox, checked: options.checkbox.checked ?? false };
		return new Promise((resolve) => this.#open({ ...options, message, cancellable: true, checkbox, resolve: (ok, shown) => resolve({ ok, checked: shown.checkbox?.checked ?? false }) }));
	}

	/** A one-line text input: resolves the text, or null when cancelled. */
	prompt(message: string, options: DialogOptions & { value?: string; placeholder?: string } = {}): Promise<string | null> {
		const input = { value: options.value ?? '', placeholder: options.placeholder };
		return new Promise((resolve) => this.#open({ ...options, message, cancellable: true, input, resolve: (ok, shown) => resolve(ok ? (shown.input?.value ?? '') : null) }));
	}

	message(message: string, options: DialogOptions | string = {}): Promise<void> {
		const opts = typeof options === 'string' ? { title: options } : options;
		return new Promise((resolve) => this.#open({ ...opts, message, cancellable: false, resolve: () => resolve() }));
	}
}

export const dialogs = new Dialogs();
export const ask = (message: string, options?: DialogOptions | string) => dialogs.ask(message, options);
export const message = (message: string, options?: DialogOptions | string) => dialogs.message(message, options);
export const prompt = (message: string, options?: DialogOptions & { value?: string; placeholder?: string }) => dialogs.prompt(message, options);
export const confirm = (message: string, options: DialogOptions & { checkbox: DialogCheckbox }) => dialogs.confirm(message, options);
