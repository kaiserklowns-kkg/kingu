# Release verification: Kingu.app (macOS, aarch64)

Checklist from docs/PLAN.md §7 (security baseline) and §11 (REA release verification).

## How to build and verify

    bun install
    bun run build:desktop            # tools/build-desktop.ts → target/aarch64-apple-darwin/release/bundle/macos/Kingu.app
    bun run verify:desktop           # tools/release-verify.ts on that bundle; exits 1 on any failure

- `build:desktop` = `tauri build --config src-tauri/tauri.release.conf.json --target <host> --bundles app`
  (compiles the sidecar first, adds `bundle.externalBin`), then re-signs the sidecar with
  `entitlements/agent-host.plist` and the app with `entitlements/app.plist`, then runs
  `codesign --verify --deep --strict`. Tauri signs every `Contents/MacOS` binary with the app's
  entitlements, so the per-binary entitlements are applied after bundling.
- Signing identity: `APPLE_SIGNING_IDENTITY` (Developer ID), else ad-hoc `-`
  (`bundle.macOS.signingIdentity`). No secrets are in the repo. Set `KINGU_EXPECT_TEAM_ID` when
  verifying a Developer ID build.
- `--auditable` builds the Rust binary with `cargo auditable` (`tauri build --runner cargo-auditable`)
  so REA `inspect_rust_binary` can read the dependency list. Needs `cargo install cargo-auditable`;
  not installed on the build machine used here, so this path is untested.
- `release-verify.ts` needs only Xcode CLT (`codesign`, `otool`, `plutil`); it is the CI gate. REA
  runs on top of it for a release: `open_binary` (each executable) → `inspect_signature`,
  `inspect_macho`, `inspect_plist`, `inspect_rust_binary`, `search_strings`.

## Results: build of 2026-10-18 (ad-hoc signed, not notarized)

Artifacts:

| File | Size | SHA-256 |
|---|---|---|
| `Kingu.app` (total) | 87.3 MB | — |
| `Contents/MacOS/kingu-desktop` (Rust, Tauri) | 18.9 MB | `c959c64ed1663c4f4ef307e3062b2509db42f1e21e70fca9039680664b3121d3` |
| `Contents/MacOS/kingu-agent-host` (Bun `--compile`) | 68.1 MB | `13016a34ac2515e0cc3e24f74fac1a645c831bb864be1d8634ba05c3ea01944f` |

The bundle holds 5 files: Info.plist, the two executables, `icon.icns`, `_CodeSignature/CodeResources`.
The frontend is embedded (compressed) in `kingu-desktop`.

### REA evidence

| Check | REA tool | Evidence ID | Value | Result |
|---|---|---|---|---|
| Main signature | `inspect_signature` | `ev_aaf52412b01fc8be3610e15a10aa878da58356a991cd810550504201d7742195` | identifier `ai.anthov.kingu.studio`, `hardened_runtime: true`, entitlements `{}`, cdhash `cebd8247…766e`, ad-hoc (no Team ID, no timestamp) | PASS (Team ID: n/a for ad-hoc) |
| Main Mach-O | `inspect_macho` | `ev_8ec5049096e7e3f8514e8bf64ca4e866043a96878ad81d98903f37f6662e624e` (parent `ev_cd37cb91…98cf`) | arm64 executable, 32 load commands, 15 dependencies (all `/System/Library/Frameworks` or `/usr/lib`), no LC_RPATH, LC_BUILD_VERSION minos 13.0 | PASS |
| Info.plist | `inspect_plist` | `ev_01482d2f0372269be2b4f1596433ea47508096fba4f00843dda44b58e401d22c` | `CFBundleIdentifier` ai.anthov.kingu.studio, `CFBundleShortVersionString`/`CFBundleVersion` 0.1.0 (= Cargo.toml), `LSMinimumSystemVersion` 13.0, category developer-tools, usage descriptions: Desktop/Documents/Downloads folders only, no ATS exceptions | PASS |
| Rust deps (main) | `inspect_rust_binary` | `ev_d665dd13066e26badb8d7bc3412880974993fe19416414029adb81165d5eb9fc` | no `.dep-v0` section (not built with `cargo auditable`); rustc commit inferred `58cf8f9c35b3…` (= rustc 1.99.1) | GAP: build with `--auditable` |
| Sidecar Rust deps | `inspect_rust_binary` | `ev_81c36c912729c7f5faee86caa3ec63038ec22c57654d005e61a3b0cc587f9849` | not a Rust binary (expected) | n/a |
| Sidecar signature / Mach-O | `open_binary` → `inspect_signature` / `inspect_macho` | — | not recorded: REA's Hopper provider timed out during `search_strings` on the main binary and the session could not reopen (`cleanup_incomplete`). Covered by `release-verify.ts` below | REA re-run needed |
| Embedded strings | `search_strings` | — | Hopper provider timeout (see above). Covered by `release-verify.ts` byte scan | REA re-run needed |

### release-verify.ts (all 26 checks passed)

| Check | Value |
|---|---|
| `sign.verify-deep-strict` | valid on disk, satisfies its Designated Requirement |
| `sign.main.*` | Identifier `ai.anthov.kingu.studio`, flags `0x10002(adhoc,runtime)`, entitlements `{}` |
| `sign.kingu-agent-host.*` | Identifier `ai.anthov.kingu.studio.agent-host`, flags `0x10002(adhoc,runtime)`, entitlements `{"com.apple.security.cs.allow-jit": true}` |
| `sign.same-team` | both "not set" (ad-hoc) |
| `macho.kingu-desktop.*` | 15 libs: AppKit, Security, CoreFoundation, CoreServices, WebKit, ApplicationServices, CoreGraphics, Carbon, CoreVideo, QuartzCore, Foundation, ColorSync, libSystem, libobjc, libiconv; no rpaths |
| `macho.kingu-agent-host.*` | 4 libs: libicucore, libresolv, libc++, libSystem; no rpaths |
| `plist.*` | as in the REA row above |
| `files.bundle` | 5 files; no `.map`, `.env*`, tests, sources, `node_modules`, key material |
| `strings.bundle` | no repo path, no home-folder path (`/Users/<builder>/`), no `sourceMappingURL=….map`, no API key / token / private key patterns |
| `files.frontend` | 139 files in `apps/desktop/build` (what gets embedded): none forbidden |
| `size.*` | app 87.3 MB (budget 150), sidecar 68.1 MB (budget 90), main 18.9 MB |

Also checked by hand: the bundled sidecar starts and answers JSON-RPC under the hardened runtime
(`ready` → `shutdown` → exit 0). Signed with the hardened runtime and **no** entitlements it dies
at startup (`ReferenceError: SharedArrayBuffer is not defined`: JavaScriptCore without JIT), which
is why it alone gets `cs.allow-jit`.

Fixed during verification: the first build leaked the builder's home folder into `kingu-desktop`
(115 strings: `~/.rustup/.../rust/library/...` std panic paths and `~/.cargo/registry` crate paths),
plus `env!("CARGO_MANIFEST_DIR")` from the dev sidecar lookup. Now `build-desktop.ts` sets
`--remap-path-prefix` for home, `~/.cargo`, `~/.rustup` and the repo, and the repo path is only
compiled into debug builds.

## Hardening decisions

### Capabilities (`src-tauri/capabilities/default.json`, window `main`)

`core:default` was replaced by the exact permissions the workbench calls:

| Permission | Kept / removed | Why |
|---|---|---|
| `core:default` | removed | granted every core default set: window/monitor queries, menu/tray/image creation, webview listing, `internal-toggle-devtools`, `app:*`, `resources:close`, event `emit`/`emit-to`, all `path:*` |
| `core:event:allow-listen`, `allow-unlisten` | kept (explicit) | `listen()` for workspace file changes and team sync events |
| `core:path:allow-resolve-directory` | kept (explicit) | `homeDir()` in workspace.svelte.ts |
| `core:window:allow-start-dragging` | kept | `data-tauri-drag-region` in TitleBar.svelte (overlay title bar) |
| `core:window:allow-internal-toggle-maximize` | added | double-click on the drag region (Tauri's drag script calls it) |
| `core:webview:allow-set-webview-zoom` | kept | `window.zoomLevel` setting (`getCurrentWebview().setZoom`) |
| `dialog:allow-open` | kept | Open Folder |
| `dialog:allow-message` | kept | `ask()`/`message()` (the plugin implements `ask` via `message`) |
| `dialog:allow-save` | not granted | unused |

App commands (`#[tauri::command]` in lib.rs) are not ACL-gated (no app manifest in build.rs);
each validates its arguments in Rust (paths resolved under the workspace root). Channel data
(`plugin:__TAURI_CHANNEL__|fetch`) is exempt from the ACL by Tauri. A native menu built in Rust
needs no capability; a JS-side menu would need `core:menu:*` entries.

### Config (`tauri.conf.json`)

- CSP unchanged and strict: `script-src 'self' 'wasm-unsafe-eval'` (Oniguruma WASM), no
  `unsafe-eval`; `connect-src 'self' ipc: http://ipc.localhost`. Team server calls go through Rust
  (`reqwest`), so no server origin in `connect-src`.
- `withGlobalTauri: false` (explicit).
- Devtools: the `devtools` Cargo feature is not enabled, so release builds have no inspector;
  `internal-toggle-devtools` is no longer granted either.
- `tauri-plugin-log` is registered only when `cfg!(debug_assertions)` (no log console in release;
  `log::` macros are no-ops there).
- `version` removed from tauri.conf.json, so the bundle version comes from Cargo.toml (0.1.0).
- `bundle.macOS`: `minimumSystemVersion` 13.0 (SMAppService baseline in PLAN §7.2),
  `hardenedRuntime` true, `signingIdentity` "-" (overridden by `APPLE_SIGNING_IDENTITY`),
  `entitlements` entitlements/app.plist.

### Entitlements

| Entitlement | Main | Sidecar | Why |
|---|---|---|---|
| Hardened runtime | yes | yes | required for notarization |
| `cs.allow-jit` | no | **yes** | Bun/JavaScriptCore needs MAP_JIT (verified: crashes without). WKWebView JIT runs in Apple's WebContent XPC service, not in our process |
| `cs.allow-unsigned-executable-memory` | no | no | not needed with allow-jit |
| `cs.disable-library-validation` | no | no | PLAN §7.2 |
| `cs.allow-dyld-environment-variables` | no | no | PLAN §7.2 |
| `get-task-allow` | no | no | debugging entitlement; must not ship |
| App Sandbox, `network.client` | no | no | not sandboxed: an IDE spawns shells, git, LSPs and agents anywhere |
| camera, microphone, location, etc. | no | no | unused |

The terminal host daemon `Contents/MacOS/kingu-ptyd` (crates/kingu-ptyd, built by
`tools/build-ptyd.ts` as `externalBin`) is re-signed by `build-desktop.ts` with the hardened runtime,
**no** entitlements and identifier `ai.anthov.kingu.studio.ptyd`; `release-verify.ts` checks it is
present (`bundle.ptyd`) and its identifier, runtime flag and empty entitlements (`sign.kingu-ptyd.*`).
It listens only on a 0600 Unix socket inside a 0700 per-user directory and rejects peers of another
uid (`getpeereid` / `SO_PEERCRED`).

Info.plist adds only `NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`,
`NSDownloadsFolderUsageDescription` (projects opened there, and the terminal/agents/git running in
them, trigger TCC prompts).

## Gaps

- **Notarization / Developer ID**: not done. With a Developer ID: `APPLE_SIGNING_IDENTITY=… bun run
  build:desktop`, then `xcrun notarytool submit` + `xcrun stapler staple` on the re-signed app (after
  the re-sign step, so Tauri's own notarization env vars should not be set). Then re-run
  release-verify with `KINGU_EXPECT_TEAM_ID`.
- **DMG**: `--bundles dmg` would package the app before the re-sign; build the DMG from the final
  Kingu.app (e.g. `hdiutil create`) until that is wired in.
- **cargo auditable / cargo deny / cargo audit / SBOM** (PLAN §7.5): not installed here; the
  `--auditable` flag exists but is untested.
- **Claude Code** is not bundled: the sidecar needs `claude` on the login-shell PATH or
  `KINGU_CLAUDE_BIN`.
- **Isolation pattern** (PLAN §7.1) not enabled; app commands are not restricted by an app ACL
  manifest.
- **Universal / x86_64 macOS, Windows, Linux**: the sidecar script maps x86_64/aarch64 darwin,
  linux and windows-x64 triples, but only aarch64-apple-darwin was built and verified; universal
  needs a lipo'd sidecar; Windows/Linux need their own signing and checks (release-verify is
  macOS-only).
- **REA sidecar evidence**: re-run `open_binary` + `inspect_signature`/`inspect_macho` on
  `kingu-agent-host` and `search_strings` once the Hopper provider is healthy.
