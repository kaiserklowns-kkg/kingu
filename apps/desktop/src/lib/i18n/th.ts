// Thai UI catalog. Typed against en.ts: a missing or extra key fails `bun run check` (CI).
import type { en } from './en';
import { common } from './th/common';
import { ade } from './th/ade';
import { adeTasks } from './th/adeTasks';
import { workbench } from './th/workbench';
import { team } from './th/team';
import { settings } from './th/settings';
import { tools } from './th/tools';
import { chat } from './th/chat';
import { chatView } from './th/chatView';
import { chatEdits } from './th/chatEdits';
import { chatRewind } from './th/chatRewind';
import { chatInput } from './th/chatInput';
import { chatParts } from './th/chatParts';
import { chatEditor } from './th/chatEditor';
import { chatSystem } from './th/chatSystem';
import { adeWorktrees } from './th/adeWorktrees';
import { vault } from './th/vault';

export const th = { ...common, ...ade, ...adeTasks, ...workbench, ...team, ...settings, ...tools, ...chat, ...chatView, ...chatEdits, ...chatParts, ...chatEditor, ...chatSystem, ...chatRewind, ...chatInput, ...adeWorktrees, ...vault } satisfies Record<keyof typeof en, string>;
