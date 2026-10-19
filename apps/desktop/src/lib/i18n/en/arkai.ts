// UI strings of Arkai on the user's model providers (agent/arkai.ts: the chat's model picker,
// Settings › Arkai's providers). Keys: 'arkai.<what>'. Thai in ../th/arkai.ts.
export const arkai = {
	// The chat's model picker when the chat runs on Arkai
	'arkai.picker.label': 'Arkai model',
	'arkai.picker.hint': 'The model Arkai runs on: your providers in kingu.arkai.providers, and Ollama on this Mac',
	'arkai.picker.loading': 'Looking for models…',
	'arkai.picker.none': 'No models: set up a provider',
	'arkai.picker.noKey': '{name} (no API key)',
	// Settings › Arkai › Model providers
	'arkai.settings.title': 'Model providers',
	'arkai.settings.hint': 'Arkai runs chats on these models. Add a provider in settings.json under kingu.arkai.providers; Ollama on this Mac is found by itself. API keys stay in the macOS Keychain.',
	'arkai.settings.empty': 'No providers yet. Start Ollama, or add one in kingu.arkai.providers.',
	'arkai.settings.refresh': 'Refresh',
	'arkai.settings.models': '{count|# model|# models}',
	'arkai.settings.local': 'On this Mac',
	'arkai.settings.found': 'Found by itself',
	'arkai.settings.hasKey': 'API key in the Keychain',
	'arkai.settings.noKey': 'No API key',
	'arkai.settings.keyLabel': 'API key for {name}',
	'arkai.settings.keyPlaceholder': 'Paste the API key',
	'arkai.settings.saveKey': 'Save Key',
	'arkai.settings.removeKey': 'Remove Key',
	'arkai.settings.listFailed': 'Models not listed: {error}',
	'arkai.settings.keyFailed': 'API key not changed: {error}'
} as const;
