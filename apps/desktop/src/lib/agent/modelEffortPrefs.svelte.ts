// Per-model effort choices for the Agents Chat composer, scoped by runtime. This keeps changing
// from Opus to a different model from silently carrying over an effort that was chosen for Opus.

import type { ChatMeta } from './chats.ts';

export type EffortPreference = NonNullable<ChatMeta['effort']>;

const KEY = 'kingu.chat.modelEffortPreferences';

function read(): Record<string, EffortPreference> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
		const allowed = new Set<EffortPreference>(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
		return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, EffortPreference] => typeof entry[1] === 'string' && allowed.has(entry[1] as EffortPreference)));
	} catch {
		return {};
	}
}

class ModelEffortPreferences {
	private values = $state<Record<string, EffortPreference>>(read());

	get(runtime: string, model: string): EffortPreference | undefined {
		return this.values[`${runtime}:${model}`];
	}

	set(runtime: string, model: string, effort: EffortPreference) {
		if (!model) return;
		this.values = { ...this.values, [`${runtime}:${model}`]: effort };
		try {
			localStorage.setItem(KEY, JSON.stringify(this.values));
		} catch {
			// Storage off: the preference lasts until the app quits.
		}
	}
}

export const modelEffortPrefs = new ModelEffortPreferences();
