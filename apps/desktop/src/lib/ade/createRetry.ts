// Orca's create retry on a name conflict (shared/new-workspace/worktree-create-retry-policy.ts):
// when git says the branch or folder already exists, try `name-2`, `name-3`… up to 25 tries. Pure.

/** Orca `CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS`. */
export const CREATE_MAX_ATTEMPTS = 25;

/** Orca `getClientWorktreeCreateCandidate`: attempt 0 is the name itself, then `-2`, `-3`… */
export const createCandidate = (slug: string, attempt: number) => (attempt === 0 ? slug : `${slug}-${attempt + 1}`);

/** Git's "a branch named … already exists" / "'<path>' already exists" (Orca's retryable conflicts). */
export const isNameConflict = (message: string) => /already exists/i.test(message) && !/not a valid|invalid/i.test(message);

/** The next free candidate after `attempt`, skipping names already `taken`; null past the limit. */
export function nextCandidate(slug: string, attempt: number, taken: ReadonlySet<string>): { slug: string; attempt: number } | null {
	for (let a = attempt + 1; a < CREATE_MAX_ATTEMPTS; a++) {
		const c = createCandidate(slug, a);
		if (!taken.has(c)) return { slug: c, attempt: a };
	}
	return null;
}
