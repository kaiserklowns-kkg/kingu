// What an agent on an SSH host asks, as the side bar's card shows it, and how its answer goes
// back. Pure.
//
// Orca surfaces a remote agent's prompt from the hook events its relay forwards over the SSH
// channel (src/main/agent-hooks/server/server-ingest-remote.ts) and answers it the two ways a local
// one is answered: a Claude PermissionRequest that waits in Orca's hold gets Claude's own decision
// (src/main/agent-hooks/server/claude-permission-hook-hold.ts, a 122 s budget that ends with `{}`,
// never an allow), and anything else is typed into the agent's PTY, which for a remote pane is the
// relay's PTY on the host (src/renderer/src/components/native-chat/session/terminal/send/
// use-native-chat-interactive-send.ts: "Reuse composer routing to the live local/remote PTY;
// selector agents receive keystrokes"). Kingu has no relay: the hold script waits on the host
// (ssh_holder.rs) and its answer is written there over ssh, and the keys go into the tab's
// `ssh -t`, whose PTY is the agent's on the host.
//
// - `hold`: Claude waits in Kingu's hold on the host: Allow / Allow for this session / Always allow
//   (in this project, everywhere) / Deny with a reason, as Claude's own decision.
// - `keys`: no hold (another CLI, or a claude without the hold script), or a question with its
//   options: Enter / Esc, or the question UI's keys (ask.ts), typed into the agent's terminal.
// - `terminal`: a question without options: only its terminal can answer.
// - `expired`: nothing can be answered from here. `timeout`: Kingu's hold ran out (Claude got
//   `{}` and asks in its own terminal now; never an allow). `disconnected`: the connection to the
//   host dropped mid-question; a hold still waiting on the host comes back when it reconnects.

import type { AskPrompt } from "#lib/agent/ask.ts";
import { liveHold, needsInput, type HookState } from "./agentHooks";
import { scopedGrants, type Grant } from "./permissionAsk";

export type RemoteAskRoute = "hold" | "keys" | "terminal" | "expired";
export type RemoteAskExpiry = "timeout" | "disconnected";

export type RemoteAskView = {
  kind: "permission" | "question";
  route: RemoteAskRoute;
  expired?: RemoteAskExpiry;
  tool?: string;
  detail?: string;
  unsandboxed?: boolean;
  /** What "Allow for this session" grants (only through the hold). */
  grants: Grant[];
  /** Claude's suggested allow rules: what "Always allow" saves (only through the hold). */
  rules: Grant[];
  /** The question's options (`keys` for a question). */
  ask?: AskPrompt;
  /** The hold the answer goes to (`hold`). */
  hold?: string;
};

/**
 * The open prompt of an agent on a host, or null when it asks nothing. `connected`: its host's
 * connection is up; `hooked`: Kingu reads its hook file there (it has a token); `now`: Unix ms.
 */
export function remoteAsk(
  h: HookState | undefined,
  o: { connected: boolean; hooked: boolean; now: number },
): RemoteAskView | null {
  if (!h || !needsInput(h)) return null;
  const kind = h.permission ? "permission" : "question";
  const base = {
    kind,
    grants: [] as Grant[],
    rules: [] as Grant[],
    ...(h.permission && h.request
      ? {
          tool: h.request.tool,
          detail: h.request.detail,
          ...(h.request.unsandboxed ? { unsandboxed: true } : {}),
        }
      : {}),
  } as const;
  if (!o.connected)
    return { ...base, route: "expired", expired: "disconnected" };
  if (!h.permission)
    return h.ask
      ? { ...base, route: "keys", ask: h.ask }
      : { ...base, route: "terminal" };
  if (o.hooked && h.hold) {
    const hold = liveHold(h, o.now);
    if (!hold) return { ...base, route: "expired", expired: "timeout" };
    const grants = h.request && !h.request.unsandboxed ? h.request.grants : [];
    return {
      ...base,
      route: "hold",
      hold: hold.id,
      grants,
      rules: scopedGrants(grants, "project"),
    };
  }
  return { ...base, route: "keys" };
}

/** The bytes a permission prompt without a hold takes: Enter (its first choice, "Yes") or Esc. */
export const permissionKey = (allow: boolean) => (allow ? "\r" : "\x1b");

/**
 * The hook state once the card's answer reached the agent, until its next hook event (the local
 * card does the same, cliSessions.svelte.ts): no longer waiting, so the card goes and can't send
 * a second answer.
 */
export function answeredHook(
  h: HookState,
  o: { allow: boolean; question?: boolean; message: string; now: number },
): HookState {
  if (o.question)
    return h.question
      ? {
          ...h,
          phase: "working",
          question: false,
          ask: undefined,
          message: o.message,
          at: o.now,
        }
      : h;
  return h.permission
    ? {
        ...h,
        phase: o.allow ? "working" : "idle",
        permission: false,
        hold: undefined,
        request: undefined,
        message: o.message,
        at: o.now,
      }
    : h;
}
