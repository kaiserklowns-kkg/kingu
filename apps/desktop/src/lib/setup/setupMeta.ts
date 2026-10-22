import type { MessageKey } from '#lib/i18n/index.ts';

export type CheckTitle = Extract<MessageKey, `setup.check.${string}.title`>;
export type CheckDesc = Extract<MessageKey, `setup.check.${string}.desc`>;
export type CheckMeta = { title: CheckTitle; desc: CheckDesc };

export const CHECK_META: Readonly<Record<string, CheckMeta>> = {
	git: { title: 'setup.check.git.title', desc: 'setup.check.git.desc' },
	agents: { title: 'setup.check.agents.title', desc: 'setup.check.agents.desc' },
	gh: { title: 'setup.check.gh.title', desc: 'setup.check.gh.desc' },
	gh_auth: { title: 'setup.check.ghAuth.title', desc: 'setup.check.ghAuth.desc' },
	ripgrep: { title: 'setup.check.ripgrep.title', desc: 'setup.check.ripgrep.desc' },
	shell: { title: 'setup.check.shell.title', desc: 'setup.check.shell.desc' }
};

export const UNKNOWN_META: CheckMeta = { title: 'setup.check.unknown.title', desc: 'setup.check.unknown.desc' };

export const metaOf = (id: string): CheckMeta => CHECK_META[id] ?? UNKNOWN_META;

export const INSTALL_URL: Readonly<Record<string, string>> = {
	git: 'https://git-scm.com/downloads',
	gh: 'https://cli.github.com/'
};
