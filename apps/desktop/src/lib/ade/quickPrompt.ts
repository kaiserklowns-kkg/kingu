// A quick prompt (Orca's quick command with the Prompt action): the agent CLI of
// `kingu.agent.cli` started with the prompt, the way its profile takes one at launch
// (agentProfiles.ts). A CLI that can only have it pasted once it is up (`typePrompt`) gets
// null: Orca says such agents do not support prompt commands. Pure.
import { parseCliCommand } from './agentCli.ts';
import { profileOf } from './agentProfiles.ts';

export function quickPromptArgv(cliSetting: string, prompt: string): string[] | null {
	const base = parseCliCommand(cliSetting.trim() || 'claude');
	if (!base || !prompt.trim()) return null;
	const launch = profileOf(base).launch(base, { prompt }, { servers: {}, plugins: [] });
	return launch.typePrompt !== undefined || launch.files?.length ? null : launch.argv;
}
