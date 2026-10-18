# @kingu/agent-host

Sidecar that runs Claude Agent SDK sessions for the desktop app. Rust (`src-tauri/src/agent/host.rs`)
starts one per app and talks newline-delimited JSON-RPC 2.0 over stdio; see `src/protocol.ts`.

- Requests: `start {runId, cwd, prompt, model?, permissionMode?, resume?, images?}`, `send {runId, text, images?}` (`images`: absolute png/jpeg/gif/webp paths, sent as base64 image blocks before the text; 5 MB each, 20 per message, 20 MB in all),
  `answer {runId, requestId, decision: allow|allow_always|deny, message?}`, `interrupt {runId}`,
  `stop {runId}`, `shutdown`.
- Notifications: `ready {sdkVersion}`, `event {runId, event}` (normalized `AgentEvent`, snake_case).
- Permission prompts come from the SDK's `canUseTool`; "allow always" becomes a `session`-scoped
  rule, never written to settings files. Closing stdin ends every run and exits.
- Safety checks (`src/guards/`, ported from goose by way of old Kingu's Arkai; Apache-2.0, see
  NOTICE): a PreToolUse hook, so they hold in every permission mode. A catastrophic Bash command
  (`rm -rf /`, `curl … | sh`, …) and the third identical tool call in a row are denied, with a
  `guard_blocked` event. `start {safetyChecks: false}` turns them off.
- `start {systemPromptAppend}`: project rules (Rust `agent/rules.rs`) after Claude Code's own prompt.

## Dev

    bun install            # at the repo root
    bun test               # protocol tests with a fake SDK query (no model calls)
    bunx tsc --noEmit

`tauri dev` finds `src/main.ts` relative to the repo and runs it with `bun run` (bun from the login
shell PATH, `KINGU_BUN`, or `~/.bun/bin`). Override with `KINGU_AGENT_HOST=/path/to/main.ts` or a
compiled binary.

## Release

    bun run build          # scripts/build-sidecar.ts → ../desktop/src-tauri/binaries/kingu-agent-host-<triple>

`bun run build:desktop` (repo root, `tools/build-desktop.ts`) runs this as part of
`beforeBuildCommand` (from `src-tauri/tauri.release.conf.json`, which also adds
`bundle.externalBin`). Tauri copies it to `Kingu.app/Contents/MacOS/kingu-agent-host` (triple
stripped), where `host.rs` finds it next to the app executable. The target is `--target`,
`TAURI_ENV_TARGET_TRIPLE` or the rustc host triple; `binaries/` is gitignored.

The executable embeds the Bun runtime and the bundled SDK (`--minify`, no source map, `.env` and
`bunfig.toml` autoload disabled), so it needs nothing from the repo or `node_modules` at runtime.
On macOS it is signed with the hardened runtime and `cs.allow-jit` only
(`src-tauri/entitlements/agent-host.plist`): JavaScriptCore fails at startup without it.

A compiled binary cannot use the SDK's per-platform bundled Claude Code, so it uses
`KINGU_CLAUDE_BIN` or `claude` on the login-shell PATH (Claude Code must be installed separately).
(Alternatively embed the platform package's `claude` with `import … with { type: 'file' }` +
`extractFromBunfs`, see the SDK README; it would then need its own signature in the bundle.)
