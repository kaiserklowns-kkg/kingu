// Per-OS UI profiles: macOS is live; Windows and Oceans (the team's own OS, not Linux) are prepared
// but not switched on yet. Pure, so it is unit-testable; platform.svelte.ts applies the profile.

export type Platform = 'mac' | 'windows' | 'linux' | 'oceans';

export type PlatformProfile = {
	id: Platform;
	label: string;
	/** Where the window controls live: macOS traffic lights (left, drawn by the OS), Windows caption buttons (right, drawn by us), or Oceans' own. */
	windowControls: 'traffic-lights' | 'caption-right' | 'oceans';
	/** Title bar space reserved on the left for OS-drawn controls. */
	leftInset: number;
	/** Title bar space our own window controls take on the right. */
	rightControlsWidth: number;
	/** Shows the in-window menu bar (macOS uses the system menu bar). */
	inWindowMenu: boolean;
	/** Primary modifier shown in key hints. */
	modKey: string;
};

export const PROFILES: Record<Platform, PlatformProfile> = {
	mac: { id: 'mac', label: 'macOS', windowControls: 'traffic-lights', leftInset: 70, rightControlsWidth: 0, inWindowMenu: false, modKey: '⌘' },
	// Windows 11: three 46px caption buttons at the right, Segoe UI Variable (set in layout.css).
	windows: { id: 'windows', label: 'Windows', windowControls: 'caption-right', leftInset: 0, rightControlsWidth: 138, inWindowMenu: true, modKey: 'Ctrl' },
	linux: { id: 'linux', label: 'Linux', windowControls: 'caption-right', leftInset: 0, rightControlsWidth: 138, inWindowMenu: true, modKey: 'Ctrl' },
	// Placeholder until Oceans' design guidelines arrive: controls at the right, our own look.
	oceans: { id: 'oceans', label: 'Oceans', windowControls: 'oceans', leftInset: 0, rightControlsWidth: 96, inWindowMenu: true, modKey: 'Ctrl' }
};

/** Profiles switched on for real users. The others render only through the developer preview. */
export const LIVE_PLATFORMS: readonly Platform[] = ['mac'];

/** The OS from the webview's user agent. Oceans is assumed to identify itself with an `Oceans` token. */
export function detectPlatform(userAgent: string): Platform {
	if (/\bOceans\b/i.test(userAgent)) return 'oceans';
	if (/Mac/i.test(userAgent)) return 'mac';
	if (/Windows/i.test(userAgent)) return 'windows';
	return 'linux';
}

/**
 * The profile the UI uses: a developer preview override, else the detected OS when its profile is
 * live, else macOS (today's behavior everywhere).
 */
export function uiPlatform(detected: Platform, override: Platform | null, live: readonly Platform[] = LIVE_PLATFORMS): Platform {
	if (override) return override;
	return live.includes(detected) ? detected : 'mac';
}
