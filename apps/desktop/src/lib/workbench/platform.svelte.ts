// Applies the UI platform profile: `data-platform` on <html> (fonts and other CSS in layout.css)
// and the profile for the title bar. A developer preview can show another OS's chrome on this machine.
import { detectPlatform, PROFILES, uiPlatform, type Platform } from './platform';

const PREVIEW_KEY = 'kingu.dev.platformPreview';

function readPreview(): Platform | null {
	try {
		const v = localStorage.getItem(PREVIEW_KEY);
		return v && v in PROFILES ? (v as Platform) : null;
	} catch {
		return null;
	}
}

class PlatformState {
	readonly detected: Platform = typeof navigator === 'undefined' ? 'mac' : detectPlatform(navigator.userAgent);
	preview = $state<Platform | null>(readPreview());
	current = $derived(uiPlatform(this.detected, this.preview));
	profile = $derived(PROFILES[this.current]);

	setPreview(p: Platform | null) {
		this.preview = p;
		try {
			if (p) localStorage.setItem(PREVIEW_KEY, p);
			else localStorage.removeItem(PREVIEW_KEY);
		} catch {
			// Preview is a developer convenience.
		}
	}
}

export const platform = new PlatformState();
