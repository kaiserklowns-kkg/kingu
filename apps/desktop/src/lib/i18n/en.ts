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
import { chatParts } from './en/chatParts';
import { chatEditor } from './en/chatEditor';
import { chatSystem } from './en/chatSystem';

export const en = { ...common, ...ade, ...adeTasks, ...workbench, ...team, ...settings, ...tools, ...chat, ...chatView, ...chatEdits, ...chatParts, ...chatEditor, ...chatSystem, ...chatRewind } as const;

export type MessageKey = keyof typeof en;
