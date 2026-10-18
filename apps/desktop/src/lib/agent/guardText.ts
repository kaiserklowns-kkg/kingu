// "Blocked by Kingu safety check: <reason>" for a `guard_blocked` event (agent-host guards/): the
// blocking threats in the UI language (goose's pattern names of the critical patterns), else
// goose's own English description. Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';
import type { AgentEvent } from './events';

export type GuardBlocked = Extract<AgentEvent, { kind: 'guard_blocked' }>;

/** The critical patterns (only those block at goose's 0.8 threshold) that have a translation. */
const THREATS = {
	rm_rf_root_bare: 'rmRfRootBare',
	rm_rf_home_or_root: 'rmRfHomeOrRoot',
	dd_destruction: 'ddDestruction',
	format_drive: 'formatDrive',
	curl_bash_execution: 'curlBashExecution',
	reverse_shell: 'reverseShell',
	sudo_without_password: 'sudoWithoutPassword',
	kernel_module_manipulation: 'kernelModuleManipulation'
} as const;
type Threat = keyof typeof THREATS;
const known = (name: string): name is Threat => Object.hasOwn(THREATS, name);

/** Why it was blocked, in the UI language where Kingu knows the threat. */
export function guardReason(ev: Pick<GuardBlocked, 'check' | 'threats' | 'detail'>): string {
	if (ev.check === 'repetition') return t('chat.guard.repetition');
	if (ev.threats.length && ev.threats.every(known)) return ev.threats.map((n) => t(`chat.guard.threat.${THREATS[n]}` as const)).join('; ');
	return ev.detail || ev.threats.join(', ');
}

export const guardBlockedText = (ev: Pick<GuardBlocked, 'check' | 'threats' | 'detail'>) => t('chat.guard.blocked', { reason: guardReason(ev) });
