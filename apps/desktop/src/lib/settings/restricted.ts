// Workspace Trust's restricted settings (VS Code: `restricted: true` in a configuration schema): a
// folder's own settings (`.kingu/settings.json`, the `.code-workspace` file's `settings`, another
// root folder's file) do not set these while the window is in Restricted Mode; the user's
// settings and Kingu's per-repository store still do.
//
// The settings that pick a program to run or its environment (terminal.integrated.shell /
// shellArgs / profiles / defaultProfile / env / cwd, git.path, workbench.externalBrowser,
// http.proxy, …) are stricter than VS Code's restricted ones in Kingu: user-only in every mode
// (their schemas are `application`), so a folder never sets them, trusted or not.

/** Folder-settable settings a Restricted Mode window takes from the user only. */
export const RESTRICTED_SETTINGS: ReadonlySet<string> = new Set([
	// Schema URLs a language server downloads (VS Code's JSON support skips them in Restricted Mode).
	'json.schemas',
	// A command id run by Go to Definition and friends when there is one result.
	'editor.gotoLocation.alternativeDeclarationCommand',
	'editor.gotoLocation.alternativeDefinitionCommand',
	'editor.gotoLocation.alternativeImplementationCommand',
	'editor.gotoLocation.alternativeReferenceCommand',
	'editor.gotoLocation.alternativeTypeDefinitionCommand',
	// What a commit does next (push or sync to the remote).
	'git.postCommitCommand',
	// Automatic tasks run in a trusted window only anyway.
	'task.allowAutomaticTasks'
]);

export const isRestricted = (id: string): boolean => RESTRICTED_SETTINGS.has(id);

/** A folder's settings as a Restricted Mode window reads them: restricted ones left out (also in `[language]` blocks). */
export function withoutRestricted(values: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(values)) {
		if (isRestricted(k)) continue;
		if (/^\[.+\]$/.test(k) && v && typeof v === 'object' && !Array.isArray(v)) out[k] = withoutRestricted(v as Record<string, unknown>);
		else out[k] = v;
	}
	return out;
}
