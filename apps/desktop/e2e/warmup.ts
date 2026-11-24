import { chromium, type FullConfig } from '@playwright/test';
import { mockTauri, READY } from './mock';

/**
 * The suite runs against `vite dev`, which transforms modules on the first request. On a cold CI
 * runner that first boot takes longer than a test's timeout, so the first spec failed while the
 * rest passed. Boot the app once here, with a long budget, before any test is timed.
 */
export default async function warmup(config: FullConfig) {
	const { baseURL, channel } = config.projects[0].use;
	const browser = await chromium.launch({ channel });
	try {
		// Vite reloads the page (and can fail a dynamic import) while it optimizes dependencies, so one
		// load is not always enough. Best effort: the specs still decide whether the app works.
		for (let attempt = 0; attempt < 4; attempt++) {
			const page = await browser.newPage({ baseURL });
			try {
				await mockTauri(page, READY, '/tmp/kingu-e2e', {}, {});
				await page.goto('/', { timeout: 120_000 });
				await page.getByRole('banner').waitFor({ state: 'visible', timeout: 60_000 });
				return;
			} catch {
				// Try again with a fresh page: the modules transformed so far stay cached in the server.
			} finally {
				await page.close();
			}
		}
	} finally {
		await browser.close();
	}
}
