# REA: แก่นระบบของ VS Code, Orca และ Cursor

- **วันที่วิเคราะห์:** 2026-11-13
- **อัปเดตล่าสุด:** 2026-11-16 — ตรวจ Orca 1.4.259 (ติดตั้ง) และ VS Code stable 1.146.0
  (เครื่องนี้ยังติดตั้ง 1.143.1); Cursor 3.27.22 ไม่เปลี่ยน — delta อยู่ที่ §9
- **เครื่อง:** macOS (Darwin, arm64)
- **เครื่องมือ:** REA (`npx rea-agents@6.5.0 analyze-javascript-application`, static + inert AST) และการอ่านไฟล์ที่ติดตั้งจริงใน `/Applications`
- **ขอบเขต:** วิเคราะห์แบบ static จาก artifact ที่ติดตั้งเท่านั้น ไม่ได้รัน ไม่ได้แก้ไข และไม่ได้ต่อ debugger เข้าแอป
- **เป้าหมาย:** เข้าใจ "แก่น" ของสถาปัตยกรรม เพื่อนำไปพัฒนาต่อใน Kingu (Tauri + Rust + Svelte) ไม่ใช่แค่เทียบฟีเจอร์

> **วิธีอ่าน**
> - **observed** = REA อ่านได้ตรงจาก AST/artifact หรือไฟล์ที่ติดตั้ง
> - **inferred** = ตีความจากหลักฐานข้างต้น (มีคำกำกับ)
> - **unknown** = ยังไม่รู้ เพราะ source อยู่นอกขอบเขตที่เลือก หรือ analyzer หมด budget
>
> ตัวเลขทั้งหมดเป็น "เท่าที่วิเคราะห์ได้" ไม่ใช่ "ทั้งแอป" — bundle ใหญ่ (workbench 20 MB, molten engine 8.9 MB, Orca main 6.5 MB) ทำให้ semantic graph ถูกตัดหรือ worker หมด heap ในบางไฟล์

---

## 1. สรุปสำหรับผู้บริหาร

| | VS Code 1.143.1 | Orca 1.4.257 | Cursor 3.27.22 |
|---|---|---|---|
| ฐานระบบ | Electron + workbench เดิมของ Microsoft | Electron + React + TypeScript ที่ compile แยกโมดูล | VS Code fork + ชั้น "Molten" ของ Anysphere |
| แก่นที่เพิ่มใหม่ | **Agent Host** เป็น utility process แยก + Copilot/Anthropic SDK ในแอป | **Worktree-first ADE** ควบคุม TUI agent 45 ตัว ผ่าน hook + CLI control plane | **Molten Glass**: host / engine / pty-host แยกโปรเซส คุยกันด้วย MessagePort |
| จุดแข็งเชิงสถาปัตยกรรม | แยก process ตามหน้าที่, service/DI ที่ทดสอบได้, extension host | session/worktree/terminal เป็นแกนเดียว, CLI ควบคุมแอปได้เต็มรูปแบบ | แยก agent runtime ออกจาก editor, terminal คงอยู่ข้าม restart, UI design system ภายใน |
| ความเสี่ยง/บทเรียน | โค้ดก้อนใหญ่และ SDK เยอะในแอป; agent host ยังซ่อนหลัง utility process | IPC ผิวหน้ากว้างมาก (~1,214 channel), preload เปิด `api` ก้อนเดียว | bundle ใหญ่ (workbench 40 MB), engine 18 MB, ผูกกับ tmux/โครงภายใน |
| สิ่งที่ Kingu ควรลอก | process isolation + event protocol ของ Agent Host | โมเดล worktree/agent session + CLI control plane | การแยก engine/pty ออกจาก UI และ session persistence |

> ตารางนี้เป็น **ฐานวิเคราะห์ 2026-11-13** ไม่ใช่เวอร์ชันล่าสุด: 2026-11-16 Orca ติดตั้ง 1.4.259,
> VS Code stable 1.146.0 (เครื่องนี้ยัง 1.143.1), Cursor 3.27.22 — delta และผลต่อ Kingu อยู่ที่ §9

**ข้อค้นพบหลัก 5 ข้อ**

1. **ทั้งสามแอปแยก "สมองของ agent" ออกจาก UI** แต่คนละระดับ: VS Code แยกเป็น utility process `agent-host`; Orca แยก PTY เป็น daemon `orcad` แล้วให้ agent เป็น TUI process; Cursor แยกเป็น utility process `engine` + `pty-host` (observed จาก entryPoint/MessagePort)
2. **Worktree คือหน่วยของงาน ไม่ใช่แค่ branch** — Orca และ Agent Host ของ VS Code มี service สำหรับ worktree isolation, disk usage, cleanup และ per-session working directory โดยตรง (observed จากชื่อ service/ฟังก์ชัน)
3. **Agent หลายค่ายถูกรวมด้วย "session + hook + status" ไม่ใช่ SDK เดียว** — Orca รองรับ 45 TUI agent และอ่านสถานะผ่าน hook/transcript ของแต่ละค่าย; Cursor ใช้ extension `cursor-agent-host` คุยกับ AgentService ผ่าน Connect RPC (observed)
4. **Terminal ต้องอยู่รอดข้ามหน้าต่าง/แอป** — Orca ใช้ `orcad` + metadata (unix socket/named pipe + auth token) ให้ CLI ควบคุม runtime; Cursor ใช้ `pty-host` ร่วมกับ tmux session `molten-glass` (observed)
5. **ผิว IPC ที่กว้างมากคือหนี้ทางสถาปัตยกรรม** — Orca มี 933 main handlers / 866 คู่ที่จับคู่ได้ และ preload expose `api` ก้อนเดียว ~70 namespace; ตัวเลข sender validation ที่ REA เห็นมีเพียง 19 จุด (observed count; ไม่ได้แปลว่าจุดอื่นไม่ตรวจ)

---

## 2. Visual Studio Code 1.143.1

### 2.1 หลักฐานและขอบเขต

- Artifact: `/Applications/Visual Studio Code.app/Contents/Resources/app` (directory)
- SHA-256: `d3771463f7f5ff6081b691e1fa65718bd7b8bb75c9abe9b0ff7663d55f889d18`
- Evidence: `ev_5e2f6fc77c1421a1dbfcdace63daf29949fbc8e94811c8dd0f1660148096ea27`
- เลือกวิเคราะห์ 7 ไฟล์, parse สำเร็จ 5 ไฟล์ (มี parse failure 1) — 6191 ไฟล์ที่เหลือถูก inventory แต่ไม่วิเคราะห์
- `workbench.desktop.main.js` (20 MB) และ semantic graph ถูกตัดที่เพดาน 100,000 โหนด; ข้อสรุปเชิงลึกของ workbench จึงเป็น **inferred** จากชื่อ service/module และสถาปัตยกรรมที่มองเห็น

### 2.2 โครงสร้างโปรเซส (observed)

`out/mainImpl.js` spawn utility process อย่างน้อย 4 ตัว:

| Utility process | Entry point |
|---|---|
| Shared Process | `vs/code/electron-utility/sharedProcess/sharedProcessMain` |
| Extension Host | `vs/workbench/api/node/extensionHostProcess` |
| PTY Host | `vs/platform/terminal/node/ptyHostMain` |
| **Agent Host** | `vs/platform/agentHost/node/agentHostMain` |

นอกจากนี้ยังมี file watcher และ worker threads (เช่น `agentHost/node/diffWorkerMain.js` ที่ใช้ `worker_threads`)

**แก่น:** main process ทำหน้าที่ lifecycle/OS integration; งานที่เสี่ยงพังหรือใช้ CPU สูงถูกแยกออกไป — extension host พังได้โดยไม่พา editor ตาย, agent host พังได้โดยไม่พา workbench ตาย

### 2.3 Workbench และ extension model (observed + inferred)

- 97 built-in extensions (observed จาก `extensions/`)
- dependency ที่ ship มาใน `node_modules.asar` มีทั้ง `node-pty`, `ssh2`, `@parcel/watcher`, `playwright-core`, `@vscode/sandbox-runtime`, `@github/copilot-sdk`, `@anthropic-ai/sdk` (observed จาก semantic module paths และ graph modules)
- Workbench ยังเป็นโครง service/contribution เดิม: `vs/platform/*`, `vs/editor/*`, `vs/workbench/{api,browser,contrib,services}` (observed จาก path)
- `out/vs/workbench/contrib/chat` และ `contrib/agentsVoice` มี asset/Media อยู่ใน build (observed จากไฟล์)

**inferred:** VS Code ไม่ได้เปลี่ยนเป็น agent IDE แบบ fork โครงสร้าง — มันเพิ่ม agent host และ chat/voice contribution เข้าไปใน workbench เดิม ทำให้ IDE parity และ agent parity อยู่ร่วมกันได้โดยไม่ต้องแยกแอป

### 2.4 Agent Host: แก่นใหม่ของ VS Code (observed)

`agentHostMain.js` เป็น unit ใหญ่ (~4.5 MB) ที่รวม service ต่อไปนี้ (ชื่อคลาส/คีย์ที่ REA อ่านได้):

| หมวด | Service / คลาส |
|---|---|
| Agent runtime | `AgentService`, `AgentHostProviderService`, `CopilotApiService`, `sdkService` |
| Session/chat state | `SessionDataService`, `AgentHostSessionStateStore`, `AgentHostChatRowStore`, `AgentHostPeerChatStore`, `AgentHostStateManager`, `AgentHostSessionTitleController` |
| Turn/tool streaming | `AgentHostTurnService`, `AgentHostTurnTracker`, `AgentHostToolCallTracker`, `FileEditTracker`, `requestService` |
| Git/worktree | `AgentHostGitService`, `AgentHostGitStateService`, `changesetOperationService`, `AgentHostChangesetService`, `diffComputeService`, `AgentHostWorktreeIsolation`, `AgentHostWorktreeDiskUsageService`, `AgentHostWorktreeCleanupService` |
| PR/automation | `AgentHostPullRequestStatusService`, `PullRequestMutationService`, `GitHubQueryService`, `AgentHostAutomationService` |
| Terminal/permission/plugin | `TerminalManager`, `ShellManager`, `SessionPermissionManager`, `AgentPluginManager`, `SessionPluginController` |
| Storage/telemetry/auth | `AgentHostStorageService`, `AgentHostTelemetryReporter`, `otelService`, `AgentHostAuthenticationService`, `AgentHostSubscriptionService` |

โปรโตคอล event ที่เห็นเป็น literal (observed): `chat/turnStarted`, `chat/responsePart`, `chat/toolCallStart`, `chat/toolCallDelta`, `chat/toolCallComplete`, `chat/toolCallContentChanged`, `chat/turnComplete`, `chat/turnCancelled`, `chat/usage`, `chat/error`, `chat/inputRequested`, `session/chatAdded`, `session/chatRemoved`, `session/titleChanged`, `session/workingDirectorySet`, `session/configChanged`, `session/isArchivedChanged`

**นี่คือ "Agent Host Protocol" ที่ควรลอก:** state ของ session/chat อยู่ใน host, UI subscribe event, และทุก tool call มี lifecycle ครบ (start → delta → complete → content changed) พร้อม usage/error/cancel

### 2.5 บทเรียนสำหรับ Kingu

- **ทำ**: แยก agent runtime เป็นโปรเซสของตัวเอง (Kingu มี `kingud`/`kingu-ptyd` อยู่แล้ว — เพิ่ม agent supervisor หรือใช้ daemon เดิม) และใช้ event protocol แบบ turn/toolCall ข้างบนเป็นสัญญา
- **ทำ**: ให้ worktree isolation/cleanup/disk usage เป็น service ของ daemon ไม่ใช่ logic ใน UI
- **หลีกเลี่ยง**: ยัด SDK หลายค่ายเข้า binary หลัก — Kingu ใช้ sidecar (Bun) เฉพาะ provider ที่ต้องใช้ JS SDK ตามแผนเดิม
- **ข้อจำกัด**: รายละเอียดการ implement ข้างใน workbench/agentHost ยังไม่ครบ (semantic graph ถูกตัด) — ต้องวิเคราะห์ไฟล์เดี่ยวหรือใช้ source map ถ้าจะลอกรายละเอียด

---

## 3. Orca 1.4.257

### 3.1 หลักฐานและขนาด

- Artifact: `/Applications/Orca.app/Contents/Resources/app.asar`
- SHA-256: `ff700520f804a4c25494ad8d0e283efae29f143e19e1479206b9d72882bcb59c`
- Evidence: `ev_1ec31248a6cd9bcfe04c8b7c710223ca71c416ab401d1a8f7f0c9112ed249203`
- 5,147 ไฟล์ใน asar; 25 ไฟล์ที่เลือกถูก parse; 2.62M AST nodes; 3,635 findings
- โครงสร้าง: `out/main` (341), `out/shared` (3,486), `out/renderer` (1,370), `out/cli` (368), `out/mobile-web` (263), `out/packages` (6) — observed จาก asar inventory

### 3.2 สถาปัตยกรรมระดับโปรเซสและหน้าต่าง (observed)

- Main entry: `./out/main/index.js` (จาก `package.json`)
- Preload: `out/preload/index.js`
- BrowserWindow 6 จุด; webPreferences ที่อ่านได้ส่วนใหญ่เป็น `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; บาง window ใช้ `partition` แยก และ `webviewTag: true` เฉพาะงานที่ต้องใช้
- `contextBridge.exposeInMainWorld("api", api)` จุดเดียว — API เป็น object ใหญ่ที่ประกอบจาก ~70 namespace (observed จากท้ายไฟล์ preload)
- Electron utility process 1 จุด (module path เป็น dynamic จึงยังไม่รู้ว่าเป็นตัวไหน)

### 3.3 ผิว IPC: ตัวเลขจริง (observed)

- 2,206 IPC operations; 1,214 literal channels; 933 main handlers; 866 คู่ renderer↔main ที่จับคู่ได้; 135 unpaired literal
- 19 sender-validation observations
- channel prefix ที่หนาที่สุด:

| อันดับ | prefix | จำนวน channel |
|---|---|---|
| 1 | `ui` | 100 |
| 2 | `browser` | 86 |
| 3 | `pty` | 71 |
| 4 | `gh` | 61 |
| 5 | `git` | 46 |
| 6 | `plugins` | 46 |
| 7 | `fs` | 40 |
| 8 | `runtimeEnvironments` | 35 |
| 9 | `app` | 30 |
| 10 | `worktrees` | 29 |
| 11 | `jira` / `ssh` / `gitlab` | 28 each |
| 12 | `skills` | 27 |
| 13 | `linear` | 24 |
| 14 | `speech` | 23 |
| 15 | `repos` | 22 |
| 16 | `agentStatus` | 19 |
| 17 | `browserPasswords` / `orcaProfiles` | 18 each |
| 18 | `workspaceSpace` | 17 |
| 19 | `ephemeralVm` | 16 |
| 20 | `browserExtensions` | 15 |

**inferred:** Orca ไม่ได้แยก API ตามหน้าต่าง/capability แต่แยกตามโดเมนธุรกิจ และ preload รวมทุกโดเมนเป็น `api` ก้อนเดียว — ง่ายต่อการพัฒนาเร็ว แต่ทำให้ surface กว้างและตรวจสิทธิ์ยาก

### 3.4 แก่นที่ 1: Worktree-first task model (observed)

- CLI มีคำสั่ง `worktree list/show/create/ps/set` คุยผ่าน runtime RPC (`client.call('worktree.create', ...)`)
- `worktree.create` รับ parent worktree/workspace, branch, base ref, review link, setup decision, และ "startup agent" (prompt/model/effort/surface) — ตรวจ flag ให้ครบก่อนสร้างจริง
- มี `agent-scratch-worktrees.js` จำกัด path ของ worktree ที่ agent สร้างเอง (`.claude/worktrees`, `.gsd-workspaces`, `.codex-tmp`) เพื่อไม่ให้ปนกับงานผู้ใช้
- layout ของ pane/tab แยกเป็น `workspace-layout/*` (stable pane id, tab group, ownership, restore)

**แก่น:** หนึ่งงาน = หนึ่ง worktree + layout + terminal + agent session ที่มี identity คงที่; ทุกอย่างอ้างอิง worktreeId/paneId ไม่ใช่ path string ลอย ๆ

### 3.5 แก่นที่ 2: Universal TUI-agent orchestration (observed)

- `agent-kind.js` map TUI agent **45 ตัว** (claude, codex, cursor, gemini, copilot, opencode, aider, goose, amp, cline, droid, grok, devin, …)
- `agent-hook-listener/` มี provider adapter แยกต่อค่าย: claude, codex, cursor, copilot, gemini, antigravity, amp, devin, droid, command-code, … พร้อมตัวแปลง transcript/tool fields
- session มี wire contract (`agent-session-wire.js`: id/history limits) และ host authority (`agent-session-host-authority.js`: execution claim, owner binding, operation id + timestamp + replay window) พร้อม `agent-session-capabilities`, `agent-session-fork`, `agent-session-handoff`
- มี `agent-session-operation-ledger` และ `agent-status` contract สำหรับ replay/ตรวจความสดของสถานะ

**แก่น:** Orca ไม่ผูกกับ SDK ของค่ายใดค่ายหนึ่ง — มันมอง agent เป็น **process + transcript + hook events** แล้ว normalize เข้า session model เดียวกัน; นี่คือสิ่งที่ทำให้รองรับ 45 ตัวได้จริง

### 3.6 แก่นที่ 3: Daemon + CLI control plane (observed)

- `orcad` เป็น terminal daemon (มี artifact manifest: node runtime, node-pty, ripgrep, per-target slots) — เก็บ PTY ให้อยู่รอดเมื่อ UI ปิด
- CLI (`orca`) อ่าน runtime metadata จาก userData (`unix`/`named-pipe` transport + `authToken`) แล้วต่อ RPC เข้าแอป; มี timeout, remote pairing, compatibility gate และ recovery command
- `terminal-daemon` CLI มีคำสั่ง `status`/`restart` พร้อมอธิบายผลกระทบ ("restarting ENDS those processes; agents ที่ resume ได้จะกลับมาได้")
- git ใช้ `GitAdmissionScheduler`: แยก admission class `network`/`general`, route ตาม WSL distro/UNC, มี budget/queue/abort — กัน git หลายร้อยคำสั่งแย่งกันจนระบบค้าง

**แก่น:** มี "local control plane" ที่มั่นคง: UI, CLI, automation และ agent ใช้ประตูเดียวกัน (RPC) และมี metadata/token/version gate; งานที่ทับซ้อนถูกจัดคิวด้วย budget ไม่ใช่ปล่อย parallel อิสระ

### 3.7 แก่นที่ 4: ขอบเขตฟีเจอร์ที่กว้างมาก (observed)

นอกจาก IDE/agent แล้ว Orca มี: browser ในตัว (tabs, cookies, passwords, extensions), SSH/remote runtime, WSL, ephemeral VM, mobile web/push, plugins (worker/frame/declarative), speech/STT, computer use/emulator, Jira/Linear/GitHub/GitLab, usage/rate limit หลาย account, automations, skills, AI vault, workspace cleanup/disk space

**inferred:** นี่คือ "platform" ไม่ใช่ "editor" — ความซับซ้อนส่วนใหญ่อยู่ที่ integration และ state reconciliation ไม่ใช่ตัว editor

### 3.8 บทเรียนสำหรับ Kingu

- **ทำ**: คงโมเดล worktree-first และ stable identity (worktreeId/paneId/tabId) ตามที่ ADE-PARITY ใช้อยู่
- **ทำ**: แยก provider adapter ต่อ CLI (Kingu มี `status_hooks.rs` + `agentHooks.ts` แล้ว) และเพิ่ม operation ledger/claim แบบ Orca เพื่อกัน resume/handoff ชนกัน
- **ทำ**: git admission/budget สำหรับงานเบื้องหลัง (status, fetch, PR) — สำคัญเมื่อมีหลายงานพร้อมกัน
- **ทำ**: CLI control plane ที่มี metadata + token + version gate (Kingu มี `kingu task` CLI อยู่แล้ว — ให้ใช้ประตูเดียวกับ UI)
- **หลีกเลี่ยง**: preload/API ก้อนเดียวแบบ 70 namespace — ใช้ Tauri command แยกตาม capability และตรวจสิทธิ์ต่อหน้าต่าง
- **หลีกเลี่ยง**: ทำทุกโดเมนพร้อมกัน (browser, VM, mobile, speech, emulator) ก่อนแกน session/worktree/PR นิ่ง

---

## 4. Cursor 3.27.22

### 4.1 หลักฐานและขนาด

- Artifact: `/Applications/Cursor.app/Contents/Resources/app` (directory)
- SHA-256: `5fb71c8105bc3cbde51976ed02aa1042cbd0359b1164c84c68f8c8102ec878b5`
- Evidence: `ev_aad9ec88e7f61513aa936a461b2a98455b03e9b6ec09ffc74af5b23d2368cd5e`
- 19,547 ไฟล์; parse 8 ไฟล์ที่เลือก; 1.32M AST nodes; 72 javascript chunks; 17 contextBridge APIs; 28 dynamic IPC channels; 8 browser windows; 3 utility processes
- `molten/dist/engine/engine.cjs` (8.9 MB) ทำให้ worker หมด heap ระหว่าง semantic analysis; `search-worker` และ `automations-loader` เกิน budget — ข้อสรุป engine จึง partial

### 4.2 โครงสร้าง: VS Code fork + Molten (observed)

```
Electron main (out/main.js + molten host.cjs)
├─ VS Code workbench (out/vs/workbench/workbench.desktop.main.js, 40 MB)
├─ Molten host (molten/dist/electron-main/host.cjs, 1.1 MB)
│   ├─ utility process: engine   (molten/dist/engine/engine.cjs, 8.9 MB)
│   ├─ utility process: pty-host (molten/dist/pty-host/pty-host.cjs)
│   └─ watcher / workers (git, search, markdown, mermaid, highlight, …)
└─ Renderer: workbench + Molten Glass (molten/dist/renderer)
```

- Preload expose contextBridge 17 ตัว ขึ้นต้นด้วย `molten…` (`moltenShell`, `moltenBrowser`, `moltenPrefs`, `moltenBootPrefs`, `moltenCrashReport`, `moltenPathForFile`, …) — observed
- MessagePort channel ที่เป็น literal (observed): `molten:engine-port-request/port/down`, `molten:pty-host-port-request/port/if-running/up/down/not-running`, `molten:desktop-port-request/port`, `molten:window-port`
- ภายใน engine↔pty-host ยังมี message `engine-port`, `pty-host-port-request`, `pty-host-port`, `pty-host-state`, `watcher-port-request`, `watcher-port`, `watcher-exit` — observed

**แก่น:** Cursor ไม่ได้ยัด agent ไว้ใน renderer — มันมี host ที่ถือ port, engine ที่ถือสมอง, pty-host ที่ถือ terminal และ renderer เป็นเพียงผู้ subscribe; การตายของ engine ไม่ลาก workbench ตาย

### 4.3 Molten Glass + Dune (observed)

- `molten/dist/build-meta/compiler-coverage.json` เผยโครงสร้างภายใน: 1,438 ไฟล์ที่ compile ครอบ `packages/ui` (691), `molten-glass/renderer` (635), `packages/cursor-ui` (95), `dune/src` (15), `packages/virtual` (2)
- feature ภายใน renderer: `agent`, `agent-card`, `agent-actions`, `chat`, `chat-kit`, `changes`, `changes-tab`, `pr`, `pr-status`, `terminal`, `tiling`, `browser`, `automations`, `mcp`, `search`, `settings`, `voice-call`, `visualize`, `workspace-search`, …
- `packages/ui/src/{components,hooks,icons,primitives,utils}` และ `packages/cursor-ui` — design system ภายในสองชั้น (inferred: generic UI vs Cursor-specific)

**แก่น:** UI ของ agent ไม่ได้อยู่ปนกับ workbench แบบสุ่ม — มันมี package/feature boundary ของตัวเอง และมี store แยกตามโดเมน (conversation, diff, PR, queue, sending, context usage, roster, side-chat)

### 4.4 Extension suite `cursor-*` (observed)

มี 21 extension ที่ขึ้นต้นด้วย `cursor-`:

`cursor-agent-exec`, `cursor-agent-host`, `cursor-agent-worker`, `cursor-always-local`, `cursor-browser-automation`, `cursor-checkout`, `cursor-commits`, `cursor-computer-use`, `cursor-deeplink`, `cursor-explorer`, `cursor-file-service`, `cursor-local-agent-runtime`, `cursor-mcp`, `cursor-ndjson-ingest`, `cursor-polyfills-remote`, `cursor-resolver`, `cursor-resolver-helper`, `cursor-retrieval`, `cursor-shadow-workspace`, `cursor-socket`, `cursor-worktree-textmate`

- `cursor-agent-host` activation `*`, คุยกับ AgentService; มี `agentStore`, `mcpToolCall`, `checkoutBranchParams`, `agent-notes`, `cursorIgnore`, `cursorFiles`
- `cursor-local-agent-runtime` เป็น worker ที่มีคำว่า `Connect`, `checkout`, `worktree`, `shadow`, `LocalAgent` — inferred: คุยผ่าน Connect RPC และจัดการ checkout/shadow workspace
- `cursor-retrieval`, `cursor-file-service`, `cursor-resolver` = ดัชนี/ค้นหา/แก้ path ของ Cursor เอง
- `cursor-shadow-workspace` = workspace แบบ shadow (inferred: ให้ agent แก้ไฟล์โดยไม่กระทบ workspace จริงจนกว่าจะ apply)
- `cursor-checkout`, `cursor-commits`, `cursor-worktree-textmate` = งาน git/worktree

**แก่น:** Cursor ใช้ "extension" เป็นที่อยู่ของ agent feature (ไม่ใช่ใน workbench core) ทำให้เปิด/ปิด/แยก process ได้ และใช้ RPC/agent store กลาง

### 4.5 Terminal persistence (observed)

`pty-host.cjs` มีสคริปต์/สตริงที่ใช้ tmux socket `molten-glass` (`tmux -L molten-glass`), สร้าง session, capture pane, และ reconnect — หมายความว่า terminal ไม่ผูกกับ PTY ตรง ๆ ของ Electron อย่างเดียว แต่มี tmux เป็นชั้น persistence (inferred จาก shell script ที่ฝังอยู่)

### 4.6 บทเรียนสำหรับ Kingu

- **ทำ**: แยก agent engine ออกจาก UI process และให้ terminal host มีชั้น persistence (Kingu มี `kingu-ptyd` แล้ว — เพิ่ม reconnect/attach semantics แบบมี generation)
- **ทำ**: นิยาม event/protocol กลางระหว่าง engine กับ UI (turn/tool/usage/error) และให้ UI store แยกโดเมนแบบ Cursor
- **ทำ**: แยก feature เป็น module/extension boundary ภายใน (ไม่ต้องเป็น VS Code extension จริง) เพื่อให้ทดสอบและเปิด/ปิดได้
- **หลีกเลี่ยง**: bundle UI/editor เป็นก้อน 40 MB และยัด engine 18 MB ในไฟล์เดียว — Kingu ควรแยก crate/package และ lazy load
- **ข้อควรระวัง**: tmux เป็น dependency ภายนอกที่อาจไม่มีบนเครื่องผู้ใช้ — ถ้าจะลอก ต้องมี fallback เป็น PTY ตรง

---

## 5. แก่นร่วมของทั้งสามระบบ

| หลักการ | VS Code | Orca | Cursor | ข้อสรุปสำหรับ Kingu |
|---|---|---|---|---|
| แยก process ตามหน้าที่ | main / shared / extension host / pty host / agent host | main UI + orcad terminal daemon + agent TUI | main / engine / pty-host / watcher | ทำ: agent supervisor + pty daemon + UI แยกกัน |
| Session เป็น entity ที่อยู่รอด | session/chat state store + turn/tool tracker | agent-session wire + operation ledger + claim | agent host store + per-session DB (experimental) | ทำ: session store ที่มี id, owner, checkpoint, replay window |
| Worktree เป็นหน่วยงาน | worktree isolation/cleanup/disk services | worktree-first + scratch worktree | checkout/shadow workspace | ทำต่อไป: worktree เป็นแกน (Kingu ทำแล้ว) |
| Provider abstraction | AgentService/ProviderService + Copilot SDK | 45 TUI agents + hook adapters | AgentService + Connect RPC | ทำ: adapter ต่อ CLI/hook ไม่ผูก SDK เดียว |
| Event stream แทน polling | chat/turn/tool events | agent status/hook + operation ledger | engine port + stores | ทำ: typed event protocol + snapshot/replay |
| Control plane แยกจาก UI | extension host/agent host ช่องทางภายใน | CLI → unix socket + token + version gate | MessagePort + extension RPC | ทำ: CLI/automation ใช้ประตูเดียวกับ UI |
| Capability/สิทธิ์ | extension host restrictions, agent host permissions | sender validation + window capabilities (แต่ผิวกว้าง) | extension activation + MCP allowlist | ทำ: Tauri capability ต่อหน้าต่าง + tool allowlist |
| งานทับซ้อนต้องมี budget | process แยก + worker | GitAdmissionScheduler + queue | engine workers/watcher | ทำ: queue/budget สำหรับ git/fs/network |

---

## 6. นำไปใช้กับ Kingu (ลำดับที่แนะนำ)

> อัปเดต 2026-11-16: Orca 1.4.259 ทำข้อ 3 (worktree cleanup/disk usage) เป็นผลิตภัณฑ์จริงแล้ว
> และ VS Code 1.146 ทำ AHP/session continuity เป็น protocol boundary — ดู §9.4 ก่อนจัดลำดับใหม่

1. **Agent Supervisor ใน Rust daemon** — process ใหม่ (หรือ module ใน `kingud`) ที่ถือ session registry, spawn agent CLI, รับ hook/transcript, แปลงเป็น event protocol `session/*`, `turn/*`, `toolCall/*`, `usage/*` แบบ Agent Host; UI เป็นผู้ subscribe
2. **Operation ledger + claim** — ยก pattern `agent-session-host-authority` ของ Orca: operationId = timestamp + random, owner binding, worktree scope digest, replay window; กัน resume/handoff ซ้ำซ้อน
3. **Worktree services** — isolation, scratch path allowlist, disk usage/cleanup เป็น service ของ daemon (ไม่ใช่ UI)
4. **CLI control plane** — ให้ `kingu` CLI ใช้ runtime metadata (socket + token + protocol version) เหมือน Orca; คำสั่ง durable mutation ต้องมี requestId และ recovery command
5. **Git admission/budget** — จัดคิวตาม repo/WSL route และแยก network/general class; ใช้กับ status/fetch/PR polling
6. **Terminal attach/generation** — `kingu-ptyd` ต้องมี attach semantics, generation/epoch, reconnect และบอกผู้ใช้เมื่อต้อง restart (ผลกระทบต่อ agent ที่ resume ได้)
7. **Capability-first IPC** — แต่ละหน้าต่างได้ command set ของตัวเอง; หลีกเลี่ยง preload/API ก้อนเดียวแบบ Orca
8. **Feature boundaries ใน UI** — แยก store ตามโดเมน (conversation/diff/pr/queue/context/roster) และ lazy-load ตาม Cursor

**สิ่งที่ไม่ควรลอก**
- Electron fuses/Node runtime ในแอป (Kingu ใช้ Tauri จึงไม่มีปัญหานี้อยู่แล้ว)
- ผิว IPC/namespace ระดับ 70 กลุ่ม และ channel 1,200+ ที่ไม่มี schema กลาง
- การ ship SDK/telemetry/playwright ขนาดใหญ่ใน binary หลัก
- การผูกกับ tmux โดยไม่มี fallback

---

## 7. ข้อจำกัดและสิ่งที่ยังไม่รู้

- **VS Code**: parse สำเร็จ 5/7 ไฟล์; workbench 20 MB ถูกตัดใน semantic graph; ไม่ได้อ่าน source map (มี URL อยู่แต่ไม่ได้ fetch); รายละเอียดภายใน Agent Host (โครงสร้าง state, นโยบาย permission) ยังไม่ครบ
- **Orca**: `out/main/index.js` (6.5 MB) worker หมด heap ระหว่าง semantic analysis; `agent-session-operation-ledger` และ `structured-agent-session-host-assembly` เกิน budget; renderer assets 1,370 ไฟล์ไม่ได้วิเคราะห์; dynamic IPC 125 operations ยังไม่รู้ channel จริง
- **Cursor**: engine (8.9 MB) worker หมด heap; search-worker/automations-loader เกิน budget; ไม่ได้วิเคราะห์ `out/vs/workbench/workbench.desktop.main.js` (40 MB) และ renderer ทั้งหมด; กลไก AgentService/Connect RPC ภายในยังไม่รู้ endpoint/protocol จริง
- **ทุกแอป**: static analysis ไม่พิสูจน์ runtime reachability, การลงทะเบียนจริง, ค่า default หรือการบังคับใช้นโยบาย; ตัวเลข sender validation เป็น "จำนวนที่เห็น" ไม่ใช่การรับประกันความปลอดภัย

---

## 8. ภาคผนวก: Evidence และวิธีทำซ้ำ

### 8.1 Evidence IDs

| เป้าหมาย | Evidence ID | Artifact SHA-256 |
|---|---|---|
| VS Code 1.143.1 (selected sources) | `ev_5e2f6fc77c1421a1dbfcdace63daf29949fbc8e94811c8dd0f1660148096ea27` | `d3771463f7f5ff6081b691e1fa65718bd7b8bb75c9abe9b0ff7663d55f889d18` |
| Orca 1.4.257 (selected sources) | `ev_1ec31248a6cd9bcfe04c8b7c710223ca71c416ab401d1a8f7f0c9112ed249203` | `ff700520f804a4c25494ad8d0e283efae29f143e19e1479206b9d72882bcb59c` |
| Cursor 3.27.22 (selected sources) | `ev_aad9ec88e7f61513aa936a461b2a98455b03e9b6ec09ffc74af5b23d2368cd5e` | `5fb71c8105bc3cbde51976ed02aa1042cbd0359b1164c84c68f8c8102ec878b5` |

### 8.2 คำสั่งที่ใช้ (ย่อ)

```bash
npx -y rea-agents@6.5.0 analyze-javascript-application \
  "/Applications/Visual Studio Code.app/Contents/Resources/app" \
  --source-path package.json --source-path product.json \
  --source-path out/main.js --source-path out/mainImpl.js \
  --source-path out/bootstrap-fork.js \
  --source-path out/vs/workbench/workbench.desktop.main.js \
  --source-path out/vs/workbench/api/node/extensionHostProcess.js \
  --format json > vscode-core.json

npx -y rea-agents@6.5.0 analyze-javascript-application \
  /Applications/Orca.app/Contents/Resources/app.asar \
  --source-path package.json --source-path out/main/index.js \
  --source-path out/preload/index.js --source-path out/main/daemon-entry.js \
  --source-path out/cli/index.js --source-path out/cli/handlers/worktree.js \
  --source-path out/shared/agent-kind.js \
  --source-path out/shared/agent-session/agent-session-host-authority.js \
  --source-path out/shared/git/admission/git-admission-scheduler.js \
  --format json > orca-core.json

npx -y rea-agents@6.5.0 analyze-javascript-application \
  /Applications/Cursor.app/Contents/Resources/app \
  --source-path package.json --source-path product.json \
  --source-path out/main.js \
  --source-path molten/dist/electron-main/host.cjs \
  --source-path molten/dist/electron-preload/preload.cjs \
  --source-path molten/dist/pty-host/pty-host.cjs \
  --source-path molten/dist/engine/engine.cjs \
  --format json > cursor-core.json
```

> ไฟล์ JSON ของแต่ละรอบมีขนาด 284–498 MB เพราะมี inventory/hash ของทั้ง artifact; ควรอ่านด้วย filter หรือสคริปต์สรุปแทนการเปิดทั้งไฟล์

---

## 9. อัปเดต 2026-11-16: Orca 1.4.259 และ VS Code 1.146.0

> ส่วนนี้เป็น **delta** จากการตรวจซ้ำหลังรายงานฉบับ 2026-11-13 ไม่ได้รัน REA ใหม่ทั้งแอป
> Orca ตรวจจาก artifact ที่ติดตั้งและ release notes; VS Code บนเครื่องยังเป็น 1.143.1 จึงใช้
> release notes สาธารณะ (ไม่ได้ observe 1.144–1.146 ในเครื่องนี้)

### 9.1 เวอร์ชันที่ตรวจ

| | ติดตั้งบนเครื่อง | stable ล่าสุด | สถานะ |
|---|---|---|---|
| Orca | **1.4.259** | 1.4.259 (14 พ.ย. 2026) | อัปเดตจาก 1.4.257 ที่วิเคราะห์เดิม |
| VS Code | **1.143.1** | **1.146.0** (11 พ.ย. 2026) | ตามหลัง 1.144, 1.145, 1.146 |
| Cursor | 3.27.22 | 3.27.22 | ไม่เปลี่ยน |

### 9.2 Orca 1.4.257 → 1.4.259

**จาก release notes (public):**

- **1.4.258** — ลด pause ตอนเปิด workspace collection ใหญ่/ย้ายหน้าต่าง/เปลี่ยน layout,
  ลดงานของ process ที่รับ keystroke ระหว่างอัปเดต usage, คืนการ scroll chat บนมือถือ,
  ใช้ GitHub Copilot ใน Chat (Copilot CLI 1.0.88+), Pi เริ่มด้วย model/thinking level ที่เลือก,
  เพิ่ม project ได้จาก folder/URL/สร้างใหม่, handoff มีบทสนทนาเต็ม
- **1.4.259** — performance ของ sidebar/chat ที่ยาว (render เฉพาะแถวที่เห็น, terminal history
  restore โดยไม่บล็อกหน้าต่าง, Git read ระหว่างสร้าง workspace), **Settings → Workspace Cleanup**
  (review, auto cleanup, per-project rules, activity), **focused subagent view** (task, live steps,
  final answer แล้วกลับ main chat), **Kimi Code ใน Chat** (model picker, permissions, questions,
  `/compact`), dictation streaming + AI cleanup, phone tab count/sheet

**observed จาก `app.asar` ที่ติดตั้ง (1.4.259):**

- `out/shared/workspace-cleanup/*` — policy, run, evaluation, filter model/state, host identity,
  unreachable-host candidate, verdict labels
- `out/shared/rpc-contract/workspace-cleanup/*` + `out/cli/workspaces/workspace-cleanup.js` +
  `out/cli/specs/workspace-cleanup.js` + renderer `WorkspaceCleanupDialog-*.js`
  → cleanup เป็น subsystem เต็มรูปแบบ (UI + RPC + CLI) ไม่ใช่ปุ่มเดียว
- policy ที่อ่านได้: rules `merged`, `unchanged`, `inactive`, `automationRuns`,
  `orchestrationWorkers`; `keepWhen: 'uncommitted' | 'any-local-files'`; ค่าเริ่มต้นทุก rule ปิด;
  `afterDays` 1–3650; per-project `off | custom`; `WORKSPACE_ARCHIVE_SUPPORTED = false`
  ใน Orca (archive ยังไม่รองรับ) แต่ Kingu map action `archive` ไปที่ `adeTasks.archive` ที่มีอยู่
- `out/shared/agent-session/view/structured-agent-session-subagent-roster.js`,
  `.../journal/agent-session-journal-subagent-schema.js`, transcript subagent modules
  → subagent roster/visibility เป็นโมเดลข้อมูลของ session ไม่ใช่แค่ UI
- `out/shared/agent-hook-listener/providers/kimi/*`, `kimi-generation-output.js`,
  `dictation-cleanup.js` → Kimi และ dictation cleanup เป็น provider/feature ใหม่

**อ่านเชิงสถาปัตยกรรม:** cleanup ถูกยกเป็นโดเมนเดียวกับ worktree/session (มี policy, RPC, CLI,
UI) และมี safety model ที่ชัด: opt-in, preview ก่อนเปิด, `keepWhen`, per-project override,
กัน host ที่ติดต่อไม่ได้; subagent view ถูกสร้างบน session journal/roster เดียวกับ main chat

### 9.3 VS Code 1.143.1 → 1.146.0

**จาก release notes (public; ไม่ได้ observe ในเครื่อง):**

- **1.144 (28 ต.ค. 2026)** — **Agent Host Protocol (AHP) 1.0**: protocol เปิดสำหรับ live agent
  sessions, session อยู่รอดข้ามหน้าต่าง/แอป (VS Code, Copilot app, GitHub.com, mobile, CLI);
  cloud sessions; Copilot Fusion GA + Compare Models; **assisted permissions GA** (LLM ประเมิน
  ความเสี่ยงเพื่ออนุมัติ tool call เอง); working set (keep/undo ต่อไฟล์); Computer Use
  (experimental); Canvases, image generation, marketplace/connectors/memory (preview)
- **1.145 (4 พ.ย. 2026)** — remote agent host: preview app/canvas จาก remote session;
  automations ด้วย cron; agent verbosity; file exclusions; **nested sessions ใช้ harness ต่างจาก
  parent ได้** (preview) — แต่ละ chat มี model/agent/permission ของตัวเอง
- **1.146 (11 พ.ย. 2026)** — Inbox mode (sessions ที่ต้องการความสนใจ, snooze/hold);
  model comparison (preview); chat windows (แยก chat เป็นหน้าต่าง); extensions ใน Agents window;
  session list inline actions; **Local harness deprecated และจะถูกลบ ก.พ. 2027**
  เหลือ Copilot harness เป็นแกน

**อ่านเชิงสถาปัตยกรรม:** AHP 1.0 เปลี่ยน "agent host" จาก internal utility process เป็น
**protocol boundary ของผลิตภัณฑ์**; session ไม่ผูกกับหน้าต่าง/client แล้ว; harness กลายเป็นมิติที่
เลือกได้ต่อ session (mixed harness ใน nested session); permission เริ่มมีโหมด risk-based
(assisted) เทียบกับ manual/auto-approve

### 9.4 ผลต่อ Kingu (ปรับลำดับความสำคัญ)

1. **Worktree cleanup / disk usage — ยกจาก out-of-scope เป็น phase ถัดไป**
   Orca 1.4.259 ทำให้เรื่องนี้เป็น feature ที่ผู้ใช้เทียบได้ทันที. ลอก safety model ไม่ใช่แค่ปุ่ม:
   opt-in, preview ก่อนลบ, `keepWhen` (uncommitted/any-local-files), rules แยกเหตุผล
   (merged/unchanged/inactive/automation/orchestration), per-project `off|custom`, activity log,
   กัน host ที่ติดต่อไม่ได้; archive ใช้ `adeTasks.archive` (ซ่อนงาน ไม่ลบ worktree)
   **เริ่มแล้ว (2026-11-16):** port logic จริงจาก Orca 1.4.259 app.asar เป็น pure modules
   `ade/workspaceCleanupPolicy.ts` (rules, per-project `global|project-custom|project-off`),
   `workspaceCleanupEvaluation.ts` (grace 1 ชม., protection priority,
   waiting, not-removable, delete/archive), `workspaceCleanupClassify.ts` (merged/unchanged/
   inactive/archived/automation-run/orchestration-worker reasons, blockers, fingerprint, host
   identity, queue/force/approval, dismissal), `workspaceCleanupVerdict.ts` (labels),
   `workspaceCleanupFilters.ts` (filter/browse state + tolerant codec + facet ranks),
   `workspaceCleanupAppliedFilters.ts` (filter chips), `workspaceCleanupCandidateFields.ts` และ
   `workspaceCleanupRun.ts` (run/report limits) — port ครบและ wire แล้วทั้ง UI/settings/scanner/
   RPC/CLI (`kingu cleanup preview|run|report|receipt`); มี safety เพิ่มจากการตรวจงานจริง:
   worker rule ต้อง landed, กัน terminal ที่ยังเปิด, recheck ต่อ worktree ก่อนลบทุก target
   (`workspace_cleanup_inspect`), ตรวจ merged MR/PR ของ GitLab และ Bitbucket Cloud นอกเหนือจาก
   GitHub, Activity/`lastRunAt` เก็บถาวรใน localStorage (เขียนผ่าน Web Lock ข้ามหน้าต่าง) และ
   สแกน/วัดขนาดข้ามหน้าต่างพร้อมกันได้; pinned เป็น blocker; archive และ receipt/Activity แยก
   `archived`. ยังเหลือ host/repo facets (หน้าต่างหนึ่งมี repo เดียว), Activity ระดับโปรไฟล์,
   Bitbucket Server/Data Center, และการลองกับแอปที่รันจริง
2. **Subagent / session visibility** — roster + focused view ต่อ subagent (task, live steps,
   final answer) แล้วกลับ main chat; โมเดลควรอยู่ใน session journal ไม่ใช่ UI state
3. **Harness coverage** — Orca เพิ่ม Kimi Code ใน Chat; Kingu มี Kimi เป็น CLI profile
   (`agentProfiles.ts`) และ usage reader (`usage/kimi.rs`) แต่ยังไม่มี chat runtime ใน
   `agent/runtimes.rs`; Copilot ก็มี CLI profile แต่ยังไม่มี chat runtime — ควรประเมิน ACP/structured
   support ก่อนเพิ่ม
4. **Protocol shape** — ทำ boundary ของ agent host ให้มีแนวคิดเหมือน AHP (session id, event
   stream, resume/attach, client ไม่ผูกหน้าต่าง) โดยไม่ต้อง wire-compatible; เปิดทางให้ client
   อื่นต่อได้ในอนาคต
5. **Performance / permissions** — virtualize แถว chat/sidebar ที่ยาว, restore scrollback โดยไม่
   บล็อกหน้าต่าง, อ่าน Git ระหว่างสร้าง worktree; พิจารณา assisted permission เป็นโหมดที่สาม
   หลัง manual/yolo พร้อม policy และ audit
6. **ยังไม่ควรลอกตอนนี้** — cloud sessions, marketplace/connectors, phone app, image generation,
   computer use: ไกลจากแกน local-first ของ Kingu และเพิ่มผิวที่ต้องดูแล

### 9.5 Evidence

- Orca 1.4.259: `/Applications/Orca.app` (`CFBundleShortVersionString` 1.4.259,
  `orca --version` → 1.4.259); release notes
  `https://github.com/stablyai/orca/releases/tag/v1.4.259` และ `v1.4.258`;
  observed module list จาก `app.asar` (ด้านบน)
- VS Code: `/Applications/Visual Studio Code.app` ยังเป็น 1.143.1; stable ล่าสุด 1.146.0
  (`https://update.code.visualstudio.com/api/releases/stable`);
  release notes `https://code.visualstudio.com/updates/v1_144`, `v1_145`, `v1_146`
- Cursor: `/Applications/Cursor.app` 3.27.22 (ไม่เปลี่ยน)
