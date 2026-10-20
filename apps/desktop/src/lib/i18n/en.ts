// English UI catalog — the source of keys. Every key needs a Thai message in th.ts (`bun run check`
// fails otherwise) with the same {params} (i18n.test.ts). One file per area, so areas don't collide.
import { common } from './en/common';
import { ade } from './en/ade';
import { adeTasks } from './en/adeTasks';
import { workbench } from './en/workbench';
import { team } from './en/team';
import { settings } from './en/settings';
import { tools } from './en/tools';
import { chat } from './en/chat';
import { chatView } from './en/chatView';
import { chatEdits } from './en/chatEdits';
import { chatRewind } from './en/chatRewind';
import { chatRuntime } from './en/chatRuntime';
import { chatInput } from './en/chatInput';
import { chatContext } from './en/chatContext';
import { chatParts } from './en/chatParts';
import { chatEditor } from './en/chatEditor';
import { chatSystem } from './en/chatSystem';
import { adeWorktrees } from './en/adeWorktrees';
import { adeProjects } from './en/adeProjects';
import { adeWorkflow } from './en/adeWorkflow';
import { mcp } from './en/mcp';
import { vault } from './en/vault';
import { adeAttempts } from './en/adeAttempts';
import { localAi } from './en/localAi';
import { chatExtras } from './en/chatExtras';
import { adeSources } from './en/adeSources';
import { cli } from './en/cli';
import { artifacts } from './en/artifacts';
import { skills } from './en/skills';
import { arkai } from './en/arkai';
import { forge } from './en/forge';
import { language } from './en/language';
import { workspaces } from './en/workspaces';
import { ideTasks } from './en/ideTasks';
import { scmEditor } from './en/scmEditor';
import { localHistory } from './en/localHistory';
import { searchEditor } from './en/searchEditor';
import { output } from './en/output';
import { profiles } from './en/profiles';

export const en = { ...common, ...ade, ...adeTasks, ...workbench, ...team, ...settings, ...tools, ...chat, ...chatView, ...chatEdits, ...chatParts, ...chatEditor, ...chatSystem, ...chatRewind, ...chatInput, ...chatContext, ...adeWorktrees, ...adeProjects, ...adeWorkflow, ...mcp, ...vault, ...adeAttempts, ...localAi, ...chatRuntime, ...chatExtras, ...adeSources, ...cli, ...artifacts, ...skills, ...arkai, ...forge, ...scmEditor, ...localHistory, ...ideTasks, ...language, ...workspaces, ...searchEditor, ...output, ...profiles } as const;

export type MessageKey = keyof typeof en;
