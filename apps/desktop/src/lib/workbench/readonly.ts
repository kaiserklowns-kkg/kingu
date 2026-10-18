// Read-only text files (VS Code: FilesConfigurationService.isReadonly): files.readonlyInclude,
// files.readonlyExclude and files.readonlyFromPermissions. Pure.

import { enabledGlobs, globToRegExp } from '#lib/settings/mappings.ts';

export type ReadonlySettings = {
	/** files.readonlyInclude / files.readonlyExclude: glob → true. */
	include: Readonly<Record<string, unknown>>;
	exclude: Readonly<Record<string, unknown>>;
	/** files.readonlyFromPermissions. */
	fromPermissions: boolean;
};

/**
 * Whether the workspace file `rel` (absolute path `abs`) opens read-only. Globs are matched
 * against the workspace-relative path, or the absolute one when they are absolute. An exclude
 * wins over an include and over the file's permissions; an include wins over the permissions.
 */
export function isReadonly(rel: string, abs: string, settings: ReadonlySettings, fileReadonly: boolean): boolean {
	const matches = (globs: Readonly<Record<string, unknown>>) => enabledGlobs(globs).some((g) => globToRegExp(g).test(g.startsWith('/') ? abs : rel));
	if (matches(settings.exclude)) return false;
	if (matches(settings.include)) return true;
	return settings.fromPermissions && fileReadonly;
}
