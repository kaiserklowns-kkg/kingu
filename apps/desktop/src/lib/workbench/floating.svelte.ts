// The floating terminal (Orca's Floating Workspace): one shell over everything, in the IDE and
// the Agents layout. Hidden keeps the shell running; Close ends it. The rect is remembered.
import { clampRect, defaultRect, type Rect } from './floating';

const KEY = 'kingu.floatingTerminal.rect';

function load(): Rect | null {
	try {
		const r = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		return r && typeof r.x === 'number' ? r : null;
	} catch {
		return null;
	}
}

class FloatingTerminal {
	/** The shell exists (mounted) … */
	alive = $state(false);
	/** … and the panel shows. */
	visible = $state(false);
	rect = $state<Rect>({ x: 0, y: 0, w: 640, h: 360 });
	/** Bumped by Close, so the next open starts a fresh shell. */
	session = $state(0);

	toggle() {
		if (this.visible) return void (this.visible = false);
		if (!this.alive) this.rect = clampRect(load() ?? defaultRect(window.innerWidth, window.innerHeight), window.innerWidth, window.innerHeight);
		this.alive = this.visible = true;
	}

	close() {
		this.visible = this.alive = false;
		this.session++;
	}

	move(next: Rect) {
		this.rect = clampRect(next, window.innerWidth, window.innerHeight);
		try {
			localStorage.setItem(KEY, JSON.stringify(this.rect));
		} catch {
			// Storage is a convenience.
		}
	}
}

export const floating = new FloatingTerminal();
