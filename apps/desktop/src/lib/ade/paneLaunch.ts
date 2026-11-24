// An agent CLI started in a terminal tab of its own, beside the task's agent (the new-tab menu's
// agents, a quick prompt). Orca starts every agent tab through one resolver
// (shared/agent-launch/startup/tui-agent-launch-command.ts `resolveAgentLaunchCommand`): the
// agent's command override, else its launch command (`kiro-cli chat --tui`, `hermes --tui`,
// `acli rovodev run`, …), then that agent's own arguments and environment. So each harness in a
// worktree runs as configured, not only the one `kingu.agent.cli` names. Pure.

import { adeCommand, adeLaunchSpec, applyLaunchSpec, type Get } from '#lib/agent/launchSpec.ts';
import { profileOf } from './agentProfiles.ts';
import { t } from '#lib/i18n/index.ts';

export type PaneLaunch =
	| {
			argv: string[];
			/** The same launch without the prompt, with its profile: the tab keeps it so a hibernated agent resumes as it was started (hibernation.ts). */
			launch: { agent: string; argv: string[] };
			/** The prompt has to be pasted once the CLI is up, or the launch needs files of a run. */
			needsSession?: true;
	  }
	| { error: string };

/**
 * The argv of `pick` (a program from the picker, or a whole command such as `claude --model opus`)
 * in a tab of its own: its profile's launch arguments, `kingu.agent.args.<id>` (else the bypass
 * flags under `kingu.agent.cliPermissions` = `yolo`), `kingu.agent.cmdOverrides` and
 * `kingu.agent.env.<id>`; with `prompt`, the prompt the way the profile takes one at launch.
 * `{ error }` when a setting is not usable: the launch is refused rather than run differently
 * than configured, as a task's is.
 */
export function paneAgentLaunch(pick: string, get: Get, prompt?: string): PaneLaunch {
	const base = adeCommand(pick.trim() || null, get);
	if (!base) return { error: t('adeTasks.tasks.badCli') };
	const spec = adeLaunchSpec(base, get);
	if ('error' in spec) return spec;
	const profile = profileOf(base);
	const launch = profile.launch(base, prompt?.trim() ? { prompt } : { fresh: true }, { servers: {}, plugins: [] });
	const fresh = prompt?.trim() ? profile.launch(base, { fresh: true }, { servers: {}, plugins: [] }).argv : launch.argv;
	return {
		argv: applyLaunchSpec(launch.argv, spec, !!prompt?.trim()),
		launch: { agent: profile.id, argv: applyLaunchSpec(fresh, spec) },
		...(launch.typePrompt !== undefined || launch.files?.length ? { needsSession: true as const } : {})
	};
}
