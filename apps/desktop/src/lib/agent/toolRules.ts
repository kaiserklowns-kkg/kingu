// VS Code's tool approval rules in the chat's UI (the rules themselves are Rust's: agent/tool_rules):
// what a permission card's "Always allow" button says and the setting value it writes, and the
// "Auto approved by rule" line of a tool row. Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';
import type { RuleSuggestion } from './events';

export const TERMINAL_RULES = 'chat.tools.terminal.autoApprove';
export const URL_RULES = 'chat.tools.urls.autoApprove';
/** Settings an "Always allow" button may write (anything else Rust would never suggest). */
const RULE_SETTINGS: readonly string[] = [TERMINAL_RULES, URL_RULES];

/** The suggestion when it is one the card may act on. */
export function usableSuggestion(s: RuleSuggestion | null | undefined): RuleSuggestion | null {
	if (!s || !RULE_SETTINGS.includes(s.setting) || !s.keys.length || s.keys.some((k) => typeof k !== 'string' || !k.trim())) return null;
	return s;
}

const code = (s: string) => `\`${s}\``;

/** The button's label and tooltip: "Always allow `npm test …`", "Always allow docs.rs". */
export function suggestionLabel(s: RuleSuggestion): { label: string; hint: string } {
	const keys = s.keys.map(code).join(', ');
	if (s.setting === URL_RULES) {
		const domain = s.keys.map((k) => k.replace(/^https?:\/\//, '')).join(', ');
		return { label: t('chatToolRules.allow.domain', { domain }), hint: t('chatToolRules.allow.domainHint', { keys }) };
	}
	return { label: t('chatToolRules.allow.commands', { commands: s.keys.map((k) => code(`${k} …`)).join(', ') }), hint: t('chatToolRules.allow.commandsHint', { keys }) };
}

/**
 * The setting's new user value with the suggestion's keys set to true. Other entries are kept as
 * they are (an existing `false` for a key is replaced: the user chose to allow it).
 */
export function withRule(current: unknown, s: RuleSuggestion): Record<string, unknown> {
	const base = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
	for (const k of s.keys) base[k] = true;
	return base;
}

/** "Auto approved by rule `ls`" for a tool row; empty when no rule approved it. */
export function approvedByText(rules: readonly string[] | undefined): string {
	if (!rules?.length) return '';
	const list = rules.map(code).join(', ');
	return rules.length === 1 ? t('chatToolRules.approvedBy', { rules: list }) : t('chatToolRules.approvedByMany', { rules: list });
}
