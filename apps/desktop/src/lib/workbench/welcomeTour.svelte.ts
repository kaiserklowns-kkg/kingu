// First-run welcome (Orca's OnboardingFlow / FeatureTips, VS Code's Walkthroughs): shown once,
// reopened from the command palette.
const SEEN = 'kingu.welcome.seen';

class Welcome {
	open = $state(false);

	/** Opens on the very first launch only. */
	maybeShow() {
		try {
			if (localStorage.getItem(SEEN)) return;
		} catch {
			return;
		}
		this.open = true;
	}

	close() {
		this.open = false;
		try {
			localStorage.setItem(SEEN, '1');
		} catch {
			// Storage is a convenience; it shows again next launch.
		}
	}
}

export const welcome = new Welcome();
