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
import { chatInput } from './th/chatInput';

export const th = { ...common, ...ade, ...adeTasks, ...workbench, ...team, ...settings, ...tools, ...chat, ...chatView, ...chatEdits, ...chatInput } satisfies Record<keyof typeof en, string>;
