import { expect, test } from "bun:test";
import {
  applyHook,
  HOLD_BUDGET_MS,
  initialHookState,
  type HookState,
} from "./agentHooks.ts";
import { answeredHook, permissionKey, remoteAsk } from "./sshAsks.ts";

const run = (events: object[], at = 1000): HookState =>
  events.reduce<HookState>((s, e) => applyHook(s, e, at), initialHookState(0));
const held = run([
  {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    kingu_hold: "1700000000-42",
    tool_input: { command: "npm test" },
    permission_suggestions: [
      {
        type: "addRules",
        behavior: "allow",
        destination: "localSettings",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
  },
]);
const on = { connected: true, hooked: true, now: 2000 };

test("a claude waiting in the hold on the host is answered through it, with its grants and rules", () => {
  const a = remoteAsk(held, on)!;
  expect(a).toMatchObject({
    kind: "permission",
    route: "hold",
    hold: "1700000000-42",
    tool: "Bash",
    detail: "npm test",
  });
  expect(a.grants.map((g) => `${g.kind}:${g.value}`)).toEqual([
    "rule:Bash(npm test:*)",
    "mode:acceptEdits",
  ]);
  // "Always allow" saves only the allow rules.
  expect(a.rules.map((g) => g.value)).toEqual(["Bash(npm test:*)"]);
});

test("the hold's 122 s budget running out shows the prompt as expired, never answerable from the card", () => {
  const late = remoteAsk(held, { ...on, now: 1000 + HOLD_BUDGET_MS })!;
  expect(late).toMatchObject({
    route: "expired",
    expired: "timeout",
    tool: "Bash",
  });
  expect(late.grants).toEqual([]);
  expect(late.hold).toBeUndefined();
});

test("a dropped connection mid-question is expired, for a hold and for a question", () => {
  expect(remoteAsk(held, { ...on, connected: false })).toMatchObject({
    route: "expired",
    expired: "disconnected",
  });
  const q = run([
    {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which?",
            multiSelect: false,
            options: [{ label: "a" }, { label: "b" }],
          },
        ],
      },
    },
  ]);
  expect(remoteAsk(q, { ...on, connected: false })).toMatchObject({
    kind: "question",
    route: "expired",
    expired: "disconnected",
  });
  expect(remoteAsk(q, on)).toMatchObject({
    kind: "question",
    route: "keys",
    ask: { questions: [{ question: "Which?" }] },
  });
});

test("without a hold the prompt takes keys; a question without options only its terminal", () => {
  const bare = run([
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
      tool_input: { file_path: "/etc/hosts" },
    },
  ]);
  expect(remoteAsk(bare, on)).toMatchObject({
    kind: "permission",
    route: "keys",
    detail: "/etc/hosts",
    grants: [],
  });
  // A hold id with no hook file to answer through (no token): keys too.
  expect(remoteAsk(held, { ...on, hooked: false })).toMatchObject({
    route: "keys",
    grants: [],
  });
  expect(permissionKey(true)).toBe("\r");
  expect(permissionKey(false)).toBe("\x1b");
  const elicit = run([
    {
      hook_event_name: "Notification",
      notification_type: "elicitation_dialog",
      message: "MCP asks",
    },
  ]);
  expect(remoteAsk(elicit, on)).toMatchObject({
    kind: "question",
    route: "terminal",
  });
});

test("a command leaving the sandbox gets no session or saved grant", () => {
  const s = run([
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      kingu_hold: "1700000000-43",
      tool_input: { command: "curl x", dangerouslyDisableSandbox: true },
      permission_suggestions: [
        { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] },
      ],
    },
  ]);
  expect(remoteAsk(s, on)).toMatchObject({
    route: "hold",
    unsandboxed: true,
    grants: [],
    rules: [],
  });
});

test("nothing asked, nothing shown; an answer clears the wait until the next event", () => {
  expect(remoteAsk(undefined, on)).toBeNull();
  expect(
    remoteAsk(run([{ hook_event_name: "UserPromptSubmit", prompt: "go" }]), on),
  ).toBeNull();
  const allowed = answeredHook(held, {
    allow: true,
    message: "answered",
    now: 5,
  });
  expect(allowed).toMatchObject({
    phase: "working",
    permission: false,
    message: "answered",
    at: 5,
  });
  expect(allowed.hold).toBeUndefined();
  expect(remoteAsk(allowed, on)).toBeNull();
  expect(answeredHook(held, { allow: false, message: "x", now: 5 }).phase).toBe(
    "idle",
  );
  const q = run([
    {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question: "Q?", options: [{ label: "a" }] }],
      },
    },
  ]);
  expect(
    answeredHook(q, { allow: true, question: true, message: "m", now: 5 }),
  ).toMatchObject({ question: false, phase: "working", ask: undefined });
});
