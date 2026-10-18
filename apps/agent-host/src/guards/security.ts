// Kingu's safety check on shell commands (from Arkai's security.ts, after goose's security
// inspector; Apache License 2.0, see NOTICE). Before each Bash call the command is scanned for
// goose's threat patterns; one whose confidence reaches goose's default threshold (0.8, so a
// critical pattern such as `rm -rf /` or `curl … | sh`) is not run, and the model is told why.
// It runs in every permission mode (guards/index.ts registers it as a PreToolUse hook).

import { RISK_CONFIDENCE, scanForThreats, type ThreatMatch } from './patterns.ts';

/** goose's default `security.threshold`. */
export const SECURITY_THRESHOLD = 0.8;

/** The matches that stop a command, the riskiest first; none when it may run. */
export function blockingThreats(command: string, threshold = SECURITY_THRESHOLD): ThreatMatch[] {
	return scanForThreats(command).filter((match) => RISK_CONFIDENCE[match.threat.risk] >= threshold);
}

/** The blocking threats' descriptions, each once, in order. */
export function threatSummary(threats: readonly ThreatMatch[]): string {
	return [...new Set(threats.map((match) => match.threat.description))].join('; ');
}

/** What the model is told instead of the command's output. */
export function blockReason(threats: readonly ThreatMatch[]): string {
	const found = threats.map((match) => `${match.threat.description} (\`${match.text.trim()}\`)`);
	return `Kingu's safety check did not run this command: ${[...new Set(found)].join('; ')}. Do not try another way to do the same thing. If the user wants it done, tell them the command so they can run it themselves.`;
}
