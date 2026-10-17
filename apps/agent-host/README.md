# @kingu/agent-host

Sidecar that runs Claude Agent SDK sessions for the desktop app. Rust (`src-tauri/src/agent/host.rs`)
starts one per app and talks newline-delimited JSON-RPC 2.0 over stdio; see `src/protocol.ts`.

- Requests: `start {runId, cwd, prompt, model?, permissionMode?, resume?}`, `send {runId, text}`,
  `answer {runId, requestId, decision: allow|allow_always|deny, message?}`, `interrupt {runId}`,
  `stop {runId}`, `shutdown`.
- Notifications: `ready {sdkVersion}`, `event {runId, event}` (normalized `AgentEvent`, snake_case).
- Permission prompts come from the SDK's `canUseTool`; "allow always" becomes a `session`-scoped
  rule, never written to settings files. Closing stdin ends every run and exits.

## Dev

    bun install            # at the repo root
    bun test               # protocol tests with a fake SDK query (no model calls)
    bunx tsc --noEmit

`tauri dev` finds `src/main.ts` relative to the repo and runs it with `bun run` (bun from the login
shell PATH, `KINGU_BUN`, or `~/.bun/bin`). Override with `KINGU_AGENT_HOST=/path/to/main.ts` or a
compiled binary.

## Release

    bun run build          # bun build --compile → dist/kingu-agent-host

Rust looks for `kingu-agent-host` next to the app executable. Not wired into `tauri build` yet: to
ship it, copy the binary to `src-tauri/binaries/kingu-agent-host-<target-triple>` and add
`"externalBin": ["binaries/kingu-agent-host"]` to `tauri.conf.json` (`bundle`).

A compiled binary cannot use the SDK's per-platform bundled Claude Code, so it uses
`KINGU_CLAUDE_BIN` or `claude` on PATH. (Alternatively embed the platform package's `claude`
with `import … with { type: 'file' }` + `extractFromBunfs`, see the SDK README.)
