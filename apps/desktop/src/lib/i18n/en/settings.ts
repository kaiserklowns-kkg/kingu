// UI strings of the settings area. Keys: 'settings.<file>.<what>'. Thai in ../th/settings.ts.
export const settings = {
	'settings.apply.autoSaveFailed': 'Auto save failed: {error}',
	'settings.contributions.saveFailed': 'Could not save the setting: {error}',
	'settings.contributions.themePlaceholder': 'Select Color Theme (Up/Down Keys to Preview)',
	'settings.contributions.lightThemes': 'light themes',
	'settings.contributions.darkThemes': 'dark themes',
	'settings.contributions.highContrastThemes': 'high contrast themes',
	'settings.registry.invalidValue': 'The value {value} is invalid, so the next layer is used instead (expected {expected}).',
	'settings.registry.userOrRepoOnly': 'This setting can only be applied in user or repository-local settings, never by the repository itself.',
	'settings.registry.userOnly': 'This setting can only be applied in user settings, so it is ignored.',
	'settings.sections.aiCapabilities': 'AI Capabilities'
} as const;
