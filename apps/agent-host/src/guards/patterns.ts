// Ported from goose, crates/goose/src/security/patterns.rs (block/goose 04ed836), by way of
// Arkai (old Kingu, arkai/packages/extensions/src/patterns.ts).
// Copyright (c) Block, Inc. and contributors. Licensed under the Apache License 2.0
// (https://www.apache.org/licenses/LICENSE-2.0); modified for Kingu: the patterns are unchanged,
// the matcher is TypeScript. See NOTICE.

/** How much harm a pattern's command can do; goose's `RiskLevel`. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** goose's `RiskLevel::confidence_score`: how sure a match alone is of a threat. */
export const RISK_CONFIDENCE: Readonly<Record<RiskLevel, number>> = {
	critical: 0.95,
	high: 0.75,
	medium: 0.6,
	low: 0.45,
};

export interface ThreatPattern {
	readonly name: string;
	readonly pattern: string;
	readonly description: string;
	readonly risk: RiskLevel;
	readonly category: string;
}

/** goose's `THREAT_PATTERNS`, in its order. */
export const THREAT_PATTERNS: readonly ThreatPattern[] = [
	{ name: 'rm_rf_root_bare', pattern: String.raw`rm\s+(-[rRfF]+\s+)*(-[rRfF]+|--recursive|--force|--no-preserve-root)(\s+(-[rRfF]+|--recursive|--force|--no-preserve-root))*\s+['\x22]?/(\./)*(\*)?['\x22]?(\s|[;&|]|$)`, description: 'Recursive deletion of root filesystem', risk: 'critical', category: 'file-system-destruction' },
	{ name: 'rm_rf_home_or_root', pattern: String.raw`rm\s+((--[a-zA-Z][a-zA-Z\-]*|--|-[a-zA-Z]+)\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dir|-d)(\s+(--[a-zA-Z][a-zA-Z\-]*|--|-[a-zA-Z]+))*\s+['\x22]?(~|\$HOME|\$\{HOME\}|/home|/root)/?(\*)?['\x22]?(\s|[;&|]|$)`, description: 'Recursive deletion of home or root directory', risk: 'critical', category: 'file-system-destruction' },
	{ name: 'dd_destruction', pattern: String.raw`dd\s+.*if=/dev/(zero|random|urandom).*of=/dev/[sh]d[a-z]`, description: 'Disk destruction using dd command', risk: 'critical', category: 'file-system-destruction' },
	{ name: 'format_drive', pattern: String.raw`(format|mkfs\.[a-z]+)\s+[/\\]dev[/\\][sh]d[a-z]`, description: 'Formatting system drives', risk: 'critical', category: 'file-system-destruction' },
	{ name: 'curl_bash_execution', pattern: String.raw`(curl|wget)\s+.*\|\s*['"]?(?:[a-zA-Z]:)?(?:[./\\]|[a-zA-Z0-9._-]+[/\\])*(bash|sh|zsh|fish|csh|tcsh)(?:\.exe)?(?:['"]|\s|[;&|<>]|$)`, description: 'Remote script execution via curl/wget piped to shell', risk: 'critical', category: 'remote-code-execution' },
	{ name: 'bash_process_substitution', pattern: String.raw`bash\s*<\s*\(\s*(curl|wget)`, description: 'Bash process substitution with remote content', risk: 'high', category: 'remote-code-execution' },
	{ name: 'python_remote_exec', pattern: String.raw`python[23]?\s+-c\s+.*urllib|requests.*exec`, description: 'Python remote code execution', risk: 'high', category: 'remote-code-execution' },
	{ name: 'powershell_download_exec', pattern: String.raw`powershell.*DownloadString.*Invoke-Expression`, description: 'PowerShell remote script execution', risk: 'high', category: 'remote-code-execution' },
	{ name: 'ssh_key_exfiltration', pattern: String.raw`(curl|wget).*-d.*\.ssh/(id_rsa|id_ed25519|id_ecdsa)`, description: 'SSH key exfiltration', risk: 'high', category: 'data-exfiltration' },
	{ name: 'password_file_access', pattern: String.raw`(cat|grep|awk|sed).*(/etc/shadow|\.password)`, description: 'Password/shadow file access', risk: 'high', category: 'data-exfiltration' },
	{ name: 'history_exfiltration', pattern: String.raw`(curl|wget).*-d.*\.(bash_history|zsh_history|history)`, description: 'Command history exfiltration', risk: 'high', category: 'data-exfiltration' },
	{ name: 'crontab_modification', pattern: String.raw`(crontab\s+-e|echo.*>.*crontab|.*>\s*/var/spool/cron)`, description: 'Crontab modification for persistence', risk: 'high', category: 'system-modification' },
	{ name: 'systemd_service_creation', pattern: String.raw`systemctl.*enable|.*\.service.*>/etc/systemd`, description: 'Systemd service creation', risk: 'high', category: 'system-modification' },
	{ name: 'hosts_file_modification', pattern: String.raw`echo.*>(>?)\s*(/etc/hosts|hosts\.txt)|echo.*\|\s*(sudo\s+)?tee\s+(-a\s+)?/etc/hosts`, description: 'Hosts file modification', risk: 'medium', category: 'system-modification' },
	{ name: 'netcat_listener', pattern: String.raw`nc\s+(-l|-p)\s+\d+`, description: 'Netcat listener creation', risk: 'high', category: 'network-access' },
	{ name: 'reverse_shell', pattern: String.raw`(nc|netcat|bash|sh).*-e\s*(bash|sh|/bin/bash|/bin/sh)`, description: 'Reverse shell creation', risk: 'critical', category: 'network-access' },
	{ name: 'ssh_tunnel', pattern: String.raw`ssh\s+.*-[LRD]\s+\d+:`, description: 'SSH tunnel creation', risk: 'medium', category: 'network-access' },
	{ name: 'kill_security_process', pattern: String.raw`kill(all)?\s+.*\b(antivirus|firewall|defender|security|monitor)\b`, description: 'Killing security processes', risk: 'high', category: 'process-manipulation' },
	{ name: 'process_injection', pattern: String.raw`gdb\s+.*attach|ptrace.*PTRACE_POKETEXT`, description: 'Process injection techniques', risk: 'high', category: 'process-manipulation' },
	{ name: 'sudo_without_password', pattern: String.raw`echo.*NOPASSWD.*>.*sudoers`, description: 'Sudo privilege escalation', risk: 'critical', category: 'privilege-escalation' },
	{ name: 'suid_binary_creation', pattern: String.raw`chmod\s+[47][0-7][0-7][0-7]|chmod\s+\+s`, description: 'SUID binary creation', risk: 'high', category: 'privilege-escalation' },
	{ name: 'encoded_commands', pattern: String.raw`(base64|hex|url).*decode.*\|\s*(bash|sh)`, description: 'Encoded command execution', risk: 'high', category: 'command-injection' },
	{ name: 'base64_encoded_shell', pattern: String.raw`(echo|printf)\s+[A-Za-z0-9+/=]{20,}\s*\|\s*base64\s+-d\s*\|\s*(bash|sh|zsh)`, description: 'Base64 encoded shell commands', risk: 'high', category: 'command-injection' },
	{ name: 'hex_encoded_commands', pattern: String.raw`(echo|printf)\s+[0-9a-fA-F\\x]{20,}\s*\|\s*(xxd|od).*\|\s*(bash|sh)`, description: 'Hex encoded command execution', risk: 'high', category: 'command-injection' },
	{ name: 'eval_with_variables', pattern: String.raw`eval\s+\$[A-Za-z_][A-Za-z0-9_]*|\beval\s+.*\$\{`, description: 'Eval with variable substitution', risk: 'high', category: 'command-injection' },
	{ name: 'indirect_command_execution', pattern: String.raw`\$\([^)]*\$\([^)]*\)[^)]*\)|\x60[^\x60]*\x60[^\x60]*\x60`, description: 'Nested command substitution', risk: 'low', category: 'command-injection' },
	{ name: 'unicode_obfuscation', pattern: String.raw`(\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}){3,}`, description: 'Unicode character obfuscation (3+ consecutive escapes)', risk: 'medium', category: 'command-injection' },
	{ name: 'docker_privileged_exec', pattern: String.raw`docker\s+(run|exec).*--privileged`, description: 'Docker privileged container execution', risk: 'high', category: 'privilege-escalation' },
	{ name: 'container_escape', pattern: String.raw`(chroot|unshare|nsenter).*--mount|--pid|--net`, description: 'Container escape techniques', risk: 'high', category: 'privilege-escalation' },
	{ name: 'kernel_module_manipulation', pattern: String.raw`(insmod|rmmod|modprobe).*\.ko`, description: 'Kernel module manipulation', risk: 'critical', category: 'system-modification' },
	{ name: 'memory_dump', pattern: String.raw`(gcore|gdb.*dump|/proc/[0-9]+/mem)`, description: 'Memory dumping techniques', risk: 'high', category: 'data-exfiltration' },
	{ name: 'log_manipulation', pattern: String.raw`(truncate.*log|rm\s+((--[a-zA-Z][a-zA-Z\-]*|--|-[a-zA-Z]+)\s+)*/var/log(/|\s|[;&|]|$)|echo\s*>\s*/var/log)`, description: 'Log file manipulation or deletion', risk: 'medium', category: 'system-modification' },
	{ name: 'file_timestamp_manipulation', pattern: String.raw`touch\s+-[amt]\s+|utimes|futimes`, description: 'File timestamp manipulation', risk: 'low', category: 'system-modification' },
	{ name: 'steganography_tools', pattern: String.raw`\b(steghide|outguess|jphide|steganos)\b`, description: 'Steganography tools usage', risk: 'medium', category: 'data-exfiltration' },
	{ name: 'network_scanning', pattern: String.raw`\b(nmap|masscan|zmap|unicornscan)\b.*-[sS]`, description: 'Network scanning tools', risk: 'medium', category: 'network-access' },
	{ name: 'password_cracking_tools', pattern: String.raw`\bjohn\s+--[a-z]|\b(hashcat|hydra|medusa|brutespray)\b`, description: 'Password cracking tools', risk: 'high', category: 'privilege-escalation' },
];

export interface ThreatMatch {
	readonly threat: ThreatPattern;
	readonly text: string;
	readonly start: number;
}

const ORDER: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

// goose compiles each pattern with `(?i)`; one that does not compile is skipped, as there.
const COMPILED = THREAT_PATTERNS.flatMap((threat) => {
	try {
		return [{ threat, regex: new RegExp(threat.pattern, 'gi') }];
	} catch {
		return [];
	}
});

/** goose's `scan_for_patterns`: every match, the riskiest first, then by position. */
export function scanForThreats(text: string): ThreatMatch[] {
	const matches: ThreatMatch[] = [];
	for (const { threat, regex } of COMPILED) {
		for (const match of text.matchAll(regex)) {
			matches.push({ threat, text: match[0], start: match.index ?? 0 });
		}
	}
	return matches.sort((a, b) => ORDER.indexOf(b.threat.risk) - ORDER.indexOf(a.threat.risk) || a.start - b.start);
}
