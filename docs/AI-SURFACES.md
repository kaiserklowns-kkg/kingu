# AI surfaces: shared core, IDE chat, ADE agents

- **วันที่:** 2026-11-13
- **สถานะ:** implemented ถึง Phase 4 และ continuity (§9); catalog แสดงในหน้า Settings › Agents แล้ว;
  Workspace Cleanup (Orca 1.4.259) wired ครบทั้ง settings, scanner, dialog, CLI และ auto-run
  (ที่เหลือดู §13)
- **ขอบเขต:** เอกสารนี้กำหนดเส้นแบ่งระหว่าง AI core ที่ใช้ร่วมกัน, IDE surface และ ADE surface
  เพื่อไม่ให้สองฝั่งแตกเป็นระบบคนละชุด

## 1. เป้าหมาย

Kingu รวม IDE (VS Code parity) และ ADE (Orca parity) ไว้ในแอปเดียว แต่ AI ต้องเป็นชุดเดียว:

- settings, accounts, policy, MCP, skills และ agent catalog ใช้ร่วมกัน
- IDE แสดงผลเป็น **agent chat** (structured events + transcript)
- ADE แสดงผลแบบ **Orca**: task/worktree + agent CLI ใน terminal (TUI + hooks)
- ทั้งสองฝั่งต้องไม่แอบแก้ state หรือ session ของอีกฝั่ง

## 2. Invariants (ห้ามแตก)

1. **AI core เดียว** — ทุก surface อ่าน settings/accounts/policy ชุดเดียวกัน
2. **สอง surface เท่านั้น** — IDE chat และ ADE CLI; ไม่มี surface ที่สาม
3. **Run ที่เริ่มแล้วถือ launch spec ที่ capture ไว้** — เปลี่ยน setting มีผลกับ run ใหม่
   หรือผ่านคำสั่ง explicit (`set_model`, `set_permission_mode`, `set_effort`)
4. **Session มีเจ้าของเดียว** — chat เป็นของ `chats`; task CLI เป็นของ `cliSessions`;
   ไม่รวม store และไม่เขียนข้ามกัน
5. **ค่าเริ่มต้นแยกได้ แต่ catalog ต้องรวม** — `kingu.agent.runtime` (chat) และ
   `kingu.agent.cli` (ADE) ยังอยู่คนละค่าได้ โดยไม่ต้อง migrate
6. **ทุกการเปลี่ยนต้อง reversible** — feature ใหม่มี flag หรือเปิดใช้กับ run ใหม่เท่านั้น

## 3. ชั้นสถาปัตยกรรม

```text
UI
├─ IDE surface
│  ├─ AgentPanel (agent chat)
│  └─ chats store + transcript
└─ ADE surface
   ├─ AgentsLayout / TaskPage / Board
   └─ cliSessions store + hooks + PTY terminals

Shared TypeScript
├─ agent/events, normalize, policy UI, Composer, Ask/Question cards
├─ settings (registry + Orca pane)
├─ agentCatalog (รวม CLI profiles + chat runtimes; Settings › Agents, sessionHandoff)
└─ launchSpec (settings → spec กลาง; tasks, chats, AgentPanel)

Rust core
├─ agent host supervisor (agent/host.rs)
├─ agent-host sidecar (Claude SDK, ACP, Codex, Arkai)
├─ cli_server (kingu CLI control plane)
├─ pty (kingu-ptyd) + hooks
└─ worktree / tasks / PR / usage

External
├─ agent CLIs in PTY (claude, codex, gemini, …)
└─ MCP servers (shared config/trust)
```

## 4. เจ้าของ setting

| Setting | ใช้โดย | ความหมาย |
|---|---|---|
| `kingu.agent.runtime` | IDE chat | runtime เริ่มต้นของ chat (`claude`, `arkai`, ACP) |
| `kingu.agent.model` | IDE chat | model เริ่มต้นของ chat |
| `kingu.agent.acpAgents` | IDE chat | รายการ ACP agent ที่ค้นพบ |
| `kingu.chat.reasoningEffort` | IDE chat | effort เริ่มต้น |
| `kingu.agent.cli` | ADE | คำสั่ง CLI เริ่มต้นของ task |
| `kingu.agent.args.<id>` | ADE | argument ต่อ CLI profile |
| `kingu.agent.env.<id>` | ADE | env ต่อ CLI profile |
| `kingu.agent.cmdOverrides` | ADE | binary แทนต่อ profile |
| `kingu.agent.disabled` | ADE | ซ่อน TUI agent |
| `kingu.agent.cliPermissions` | ADE | `manual` / `yolo` |
| `kingu.agent.permissionMode` | ทั้งคู่ | ค่าเริ่มต้นของสิทธิ์ (SDK mode) |
| `kingu.agent.statusHooks` | ADE | hooks รายงานสถานะ CLI |
| `kingu.agent.claudeAgentTeams` | ADE | Claude agent teams (in-process) |
| `kingu.agent.hibernation*` | ADE | hibernate CLI ที่ idle |
| `kingu.agent.promptCache*` | ADE | ตัวนับเวลา prompt cache |
| `kingu.agent.safetyChecks`, `protectedPaths`, `ask.*` | ทั้งคู่ | policy (§7) |
| `kingu.agent.trustWorkspace` | ทั้งคู่ | trust ของ workspace |
| `kingu.agent.notifications*` | ทั้งคู่ | การแจ้งเตือน |
| `kingu.chat.*` | IDE chat | UI/พฤติกรรมของ chat |

**กติกา:** setting ใหม่ต้องระบุเจ้าของในตารางนี้ก่อนเพิ่มลง registry — บังคับด้วย `agent/settingOwners.ts`
(`settingOwners.test.ts` ล้มเมื่อ `kingu.agent.*` / `kingu.chat.*` ใดไม่มีเจ้าของ)

## 5. เส้นทางการรัน

### 5.1 IDE chat

- หนึ่ง chat = หนึ่ง agent-host session (`chats.svelte.ts`)
- Rust เก็บ transcript ต่อ event ที่ `.kingu/chats/<id>.jsonl`
- run key = folder + chat id; ปิด panel แล้ว run ยังทำงาน
- permission/ask ผ่าน event และ `agent_answer_permission`
- resume/fork ใช้ session id + anchor

### 5.2 ADE task (Orca)

- หนึ่ง task = หนึ่ง worktree + agent CLI ใน PTY (`cliSessions.svelte.ts`)
- สถานะมาจาก hooks, output, terminal title และ liveness ของ PTY
- `kingu-ptyd` ทำให้ terminal รอดหลังแอปปิด และ re-attach พร้อม scrollback
- ADE **ไม่เริ่ม** agent-host run แล้ว; run แบบเก่ายังถูก observe เพื่อหยุด/ลบได้
  (`ade/runtime.svelte.ts`)

### 5.3 Legacy task runs

- `agents.svelte.ts` ยังรับ event ของ run เก่าเพื่อความเข้ากันได้
- ห้ามสร้าง run ใหม่ผ่านเส้นทางนี้; ใช้ chat หรือ CLI ตาม surface

## 6. Session และ state

| | IDE chat | ADE CLI | Legacy run |
|---|---|---|---|
| Identity | chat id + session id | task slug + PTY key | slug + run id |
| Storage | `chats.json` + transcript `.jsonl` | localStorage + PTY + hooks | in-memory + transcript |
| Resume | session id / anchor | CLI profile `canResume` | session id |
| Status | events | hooks/title/liveness | events |
| Owner | `chats` | `cliSessions` | `agents` (read-only) |

## 7. Policy และสิทธิ์

ใช้ร่วมกัน:
- trust ของ workspace และ worktree scripts
- rules (AGENTS.md, `.cursor/rules`, …)
- tool rules / tool sets
- safety asks: เขียนนอก cwd, ลบไฟล์, MCP tools, protected paths
- MCP allowlist และ skill plugins

ต่างกันโดยตั้งใจ:
- CLI ใช้ flag ของแต่ละโปรแกรม (`yolo`, `--dangerously-skip-permissions`)
- chat ใช้ SDK permission mode และ permission prompt

## 8. Catalog และ LaunchSpec

### 8.1 `agentCatalog.ts` (`apps/desktop/src/lib/agent/agentCatalog.ts`)

- รวม `PROFILES` (ADE) กับ `runtimes` (chat) เป็นรายการเดียว โดย join ด้วย id (`claude`, `codex`, `gemini`, …)
- แต่ละรายการมี: `id`, `cliProfile?`, `chatRuntime?`, `surfaces`, `capabilities`
- capabilities: `structured`, `terminal`, `resume`, `fork`, `models`, `effort`
- เป็น read-only; ไม่เปลี่ยนพฤติกรรมการรัน
- **แสดงใน UI แล้ว:** หน้า Settings › Agents (`settings/pages/AgentCatalog.svelte`) โหลด
  `agentRuntimes` แล้วติด badge "IDE chat" ให้ CLI profile ที่มี chat runtime id เดียวกัน
  (Claude เสมอ; codex/gemini/qwen/opencode/goose/grok/omp เมื่อพบบน PATH) — agent ตัวเดียวกันรันได้ทั้ง
  IDE chat และ ADE terminal; ค่า default ยังแยก (`kingu.agent.cli` / `kingu.agent.runtime`) ไม่ migrate
- entry ที่มีแต่ chat (Arkai, ACP agent ที่ตั้งเอง) แสดงในส่วน "Chat" ของหน้าเดียวกัน โดยไม่มี
  control ของ ADE (ไม่มี enable/default/args) — ใช้ `panes.chat.title` เดิม ไม่เพิ่ม i18n key
- ผู้อ่านอื่น: `agent/sessionHandoff.ts` (เลือก chat runtime ที่ต่อ session ของ CLI ได้)

### 8.2 `launchSpec.ts` (`apps/desktop/src/lib/agent/launchSpec.ts`)

- `resolveLaunchSpec({ surface, agentId, get })` คืน discriminated union ตาม surface:
  - ADE: `argv`, `program?`, `env`, `claudeTeams`, `permissionMode` (`manual`/`yolo`), `mcp`, `skills`
  - IDE: `runtime`, `model`, `effort`, `permissionMode` (SDK mode), `env`
  - setting ที่ใช้ไม่ได้คืน `{ error }` (เหมือนที่ launch จริงปฏิเสธ)
- ADE `applyLaunchSpec(launchArgv, spec)` เท่ากับ `withLaunchOptions(launchArgv, launchOptions(...))`
- IDE `effort` ยังไม่กรองด้วย levels ของ model (ทำใน `runEffort` ตอน run)
- Golden rule: ผลลัพธ์ต้องเท่ากับ `commandFor`/`launchOptions` เดิมทุก profile
- **Phase 4 (wired):** production path อ่านค่าผ่าน `launchSpec.ts` แล้ว
  - ADE: `tasks.svelte.ts` (`adeCommand` สำหรับคำสั่งของ task, `adeLaunchSpec` + `applyLaunchSpec`
    ตอน launch), `sshProjects.svelte.ts`, `SshRemoteFolder.svelte`, `SshProjectsSection.svelte`
  - IDE: `chats.defaults()` (model, permission mode) และ runtime เริ่มต้นใน `AgentPanel.svelte`
  - `adeLaunchSpec(argv)` ใช้คำสั่งที่ task บันทึกไว้ตามเดิม ไม่เติม args/yolo ซ้ำ
  - effort ของ chat ยังผ่าน `effortChoice.svelte.ts` / `runEffort` เดิม (ต้องรู้ levels ของ model)

## 9. Continuity

- เริ่มจาก **deep-link**: เปิด worktree ของ task ใน IDE chat — **มีแล้ว**: เมนู worktree ของ task
  → "Open in Agent Chat" (`worktreeActions.ts` `openInChat` → `newChatInTask(slug)` ใน
  `chatCommands.svelte.ts`) สลับไป IDE แล้วเปิด chat ใหม่ที่ `cwd = { kind: 'task', slug }`;
  CLI session ของ task ไม่ถูกแตะ
- Session handoff ทำเฉพาะ runtime ที่ประกาศ `resume` และต้องเป็นคำสั่ง explicit — **มีแล้ว**:
  เมนู task → "Continue in Agent Chat…" (`agent/sessionHandoff.ts`)
  - เสนอเฉพาะ session ที่ chat runtime อ่าน session store เดียวกันได้: ตอนนี้คือ Claude Code CLI ↔
    Claude Agent SDK (`~/.claude/projects`); Codex/ACP มี store ของตัวเอง จึงไม่เสนอ
  - ต้องหยุด agent ของ task ก่อน (ไม่ให้สอง agent เขียน session เดียวกันพร้อมกัน)
  - ใช้ `chats.adopt()` เดิม (เหมือน AI Vault › Continue here): chat ใหม่ใน worktree ของ task ถือ
    session id นั้น; ถ้ามี chat ที่ต่อ session นี้อยู่แล้วจะเปิดอันเดิม
  - Kingu ไม่ย้ายหรือแก้ state ของ task (`cliSessions`/task meta) — แต่ turn ใหม่ของ chat จะต่อท้าย
    session file ของ Claude Code เอง ถ้าภายหลัง task resume session เดิม CLI จะเห็น turn เหล่านั้นด้วย
- ไม่รวม store; ไม่ย้าย transcript; ไม่เขียน state ข้าม surface

## 10. Non-goals

- รวม chat และ CLI เป็น implementation เดียว
- แทน CLI TUI ด้วย chat
- extension host แบบ VS Code (Kingu ใช้ Snaps)
- Settings Sync (ต้องมี server)
- เปลี่ยน default `kingu.agent.cli` หรือ `kingu.agent.runtime` โดยอัตโนมัติ

## 11. Code references

- `apps/desktop/src/lib/agent/chats.svelte.ts` — chat store
- `apps/desktop/src/lib/agent/agents.svelte.ts` — legacy task runs
- `apps/desktop/src/lib/agent/runtimes.ts` — chat runtimes
- `apps/desktop/src/lib/ade/cliSessions.svelte.ts` — ADE CLI sessions
- `apps/desktop/src/lib/ade/agentCli.ts` — CLI command builders
- `apps/desktop/src/lib/ade/agentProfiles.ts` — CLI profiles
- `apps/desktop/src/lib/ade/runtime.svelte.ts` — ADE runtime adapter
- `apps/desktop/src/lib/settings/registry.ts` — settings schema
- `apps/desktop/src-tauri/src/agent/host.rs` — run ownership/supervision
- `apps/desktop/src-tauri/src/cli_server.rs` — control plane
- `apps/desktop/src-tauri/src/pty.rs` — PTY backend
- `crates/kingu-ptyd/src/session.rs` — scrollback/re-attach

## 12. Definition of done (Phase 0–4)

- เอกสารนี้อยู่ใน repo และตรงกับโค้ดปัจจุบัน
- `agentCatalog.ts` + test ผ่าน
- `launchSpec.ts` + golden test ผ่าน
- ไม่มีไฟล์เดิมที่ dirty ถูกแก้
- `bun run check` ไม่สร้าง error ใหม่

## 13. สถานะ

| | รายการ | หลักฐาน |
|---|---|---|
| done | §§1–9: core เดียว, สอง surface, launch spec wired (Phase 4), deep-link + session handoff | `launchSpec.ts`, `tasks.svelte.ts`, `chats.svelte.ts`, `AgentPanel.svelte`, `sessionHandoff.ts`, `worktreeActions.ts` |
| done | catalog แสดงใน Settings › Agents (badge "IDE chat") | `settings/pages/AgentCatalog.svelte` |
| done | entry ที่มีแต่ chat (Arkai, ACP agent ที่ตั้งเอง) แสดงในส่วน "Chat" ของ Settings › Agents โดยไม่เพิ่ม i18n key | `settings/pages/AgentCatalog.svelte` (`chatOnly`) |
| done | เจ้าของ setting บังคับด้วย test (§4) | `settingOwners.ts` + `settingOwners.test.ts` |
| done | tests + `bun run check` ผ่าน | `agentCatalog`, `launchSpec`, `sessionHandoff`, `settingOwners` `.test.ts` |
| done | Workspace Cleanup: กฎ (merged / unchanged / inactive / automationRuns / orchestrationWorkers + keepWhen) ปิดทั้งหมดเป็นค่าเริ่มต้น ตั้งได้ทั้งส่วนกลางและรายโปรเจกต์ (inherit / off / own) ใน Settings › Workspace Cleanup; ไม่อ่านจาก `.kingu/settings.json` ของ repo เพราะกฎลบ worktree ได้ | `settings/ade/cleanup.ts`, `settings/pages/WorkspaceCleanupPage.svelte`, `ade/workspaceCleanupPolicy.ts` |
| done | scanner (Rust, อ่านอย่างเดียว) อ่านข้อเท็จจริงจาก Git ต่อ worktree: clean, ignored files, unpushed, merged/unchanged, last activity; ตัวตัดสินเป็น evaluator ตัวเดียวที่ port จาก Orca ใช้ร่วมกันทั้ง dialog, CLI และ auto-run | `src-tauri/src/workspace_cleanup.rs`, `ade/workspaceCleanupScan.ts`, `ade/workspaceCleanupEvaluation.ts` |
| done | dialog Clean Up Tasks: สแกนตอนเปิด, ป้าย "พร้อมลบ" / เหตุผลที่เก็บไว้, filter bar + applied-filter chips (เฉพาะ facet ที่ Kingu มีข้อมูล: ค้นหา, idle days, Git, สถานะงาน, archived, comment, agent, blockers, branch) | `ade/CleanupDialog.svelte`, `ade/CleanupFilterBar.svelte`, `ade/workspaceCleanupBrowse.ts` |
| done | CLI: `kingu cleanup preview | run [--request-id] | report | receipt`; `run` มี request-id ledger กันรันซ้ำ (id เดิมได้ใบเสร็จครั้งแรก), `report` แสดงกฎ/auto/รันล่าสุด/ครั้งถัดไป/activity ของโฟลเดอร์ (อ่านซ้ำก่อนตอบ จึงเห็น run ของหน้าต่างอื่น) | `crates/kingu-cli/src/args.rs`, `src-tauri/src/cli_server.rs`, `src-tauri/src/cli_ledger.rs`, `ade/cliBridge.svelte.ts` |
| done | auto-run (opt-in `kingu.workspaceCleanup.auto`): ตรวจหลังเปิดหน้าต่าง 2 นาทีแล้วทุกชั่วโมง ไม่รันตอน dialog เปิดหรือมี run อยู่; รายการ Activity ในหน้า settings | `ade/autoCleanup.ts`, `ade/autoCleanup.svelte.ts` |
| done | ลองกับแอปที่รันจริง (`tauri dev`, 2026-11-17 และ 11-18, repo ทดสอบ + bare remote, task ย้อนเวลา 3 วัน): `kingu cleanup preview/run/report` ผ่าน socket และ `--request-id` เล่นซ้ำ; กฎ `inactive`→`archive` (`archived_at` ถูกตั้ง, worktree ยังอยู่, sidebar ซ่อนไว้ใต้ Archived, run ซ้ำเห็น `already archived`); `kingu task create --request-id` ซ้ำได้ slug เดิมและมี task เดียว; เมนูคลิกขวาของ task เห็นครบถึง Archive; Pin แล้ว preview และ dialog ขึ้น `pinned`; dialog Clean Up Tasks ติ๊กตามกฎ, เอาติ๊กออกได้, กด Clean up แล้ว archive เฉพาะที่เลือกและลง Activity เป็น review dialog; `kingu.sidebar.hideCliCreatedTasks` ซ่อน task ที่ CLI สร้าง (รวมที่ปักหมุด) และปุ่มตัวกรองขึ้นเลข 1; auto-run รันเองราว 2 นาทีหลังเปิดแอป, ลง Activity เป็น automatic และนัดครั้งถัดไป +1 ชม.; หน้า Settings › Workspace Cleanup แสดงกฎ, สวิตช์ auto และ Activity ต่อโฟลเดอร์ที่รอด restart. ข้อสังเกต: `kingu.workspaceCleanup.auto` เป็น application scope และกฎใน `.kingu/settings.json` ถูกเมิน (restricted) ตามที่ออกแบบ. รอบ 2 (11-18): action `delete` ลบ task/worktree/branch ของ task ที่กฎจับได้ และเก็บ task ที่มีไฟล์ยังไม่ commit (`uncommitted changes`); ⇧⌘⌫ บนการ์ดที่เลือกขึ้น dialog Delete Task พร้อมคำเตือนไฟล์ค้าง; วงแหวน OSC 7501 และจุด done บน terminal tab; ลิงก์ issue จาก URL กับ GitHub จริง (เสนอ → Enter รับ → ชื่อ + pill, เอาออกแล้วชื่อหาย); Advanced → Branch name ปฏิเสธ `a/v1.2`, สร้าง branch `feature/play-override` จริง. พบและแก้: บรรทัดคำสั่งเปิด agent ที่ยาวเกิน 1024 ไบต์ถูก tty ตัด (`kingu-ptyd` `type_when_ready`). รอบ 3 (11-19): Commit (Amend) บน commit ที่ push แล้ว → ถามยืนยัน → amend → ปฏิเสธ force push แล้วปุ่มหลักยังเป็น Force Push (↑1 ↓1), เมนู Sync ขึ้นคำเตือน Undo the Amend?, กด Force Push แล้ว remote ตรงกับ local. ยังไม่เคยเห็น: การสลับโฟลเดอร์กลาง run, hibernation resume, จุดสถานะของ agent ใน terminal tab ที่สอง, ชื่อสัตว์ทะเล | — |
| done | ledger ของ request id เก็บใบเสร็จที่เสร็จแล้ว (ล่าสุด 64 ใบ) ในไฟล์ `cleanup-runs.json` ของโฟลเดอร์ config ของแอป จึงรอด restart; run ที่ค้างตอนปิดแอปไม่ถูกจำ (รันซ้ำปลอดภัยเพราะ task ที่ลบแล้วไม่ถูกเห็นอีก); ยังแยกจาก `agent/op_ledger.rs` (id ของ Orca เป็นคนละรูปแบบกับ `--request-id`) | `cli_ledger.rs` |
| done | `kingu cleanup run` รอได้ 10 นาทีฝั่งแอป (11 นาทีฝั่งคำสั่ง) แทน 30 วินาที | `cli_server.rs` `CLEANUP_RUN_TIMEOUT`, `kingu-cli/src/client.rs` `answer_timeout` |
| done | facet ขนาดใน dialog: Rust `workspace_cleanup_sizes` วัด `du -sk` ต่อ worktree (ช้า จึงแยกจากการสแกน Git; dialog ใช้งานได้ก่อนแล้วขนาดตามมา), กรองขนาดขั้นต่ำ/สูงสุด + "รวมที่วัดไม่ได้", เรียงตามขนาด, แสดงขนาดบนแถวและยอดที่จะได้คืน | `src-tauri/src/workspace_cleanup.rs`, `ade/cleanup.svelte.ts`, `ade/workspaceCleanupBrowse.ts` |
| done | facet สถานะ PR/review (open/draft/merged/closed/ยังไม่อ่าน + มี/ไม่มี PR) และแหล่ง ticket (issue/Linear + มี/ไม่มี): อ่าน PR ด้วย `prStatuses.refresh` เบื้องหลังหลังสแกน (ทีละ 3 งาน, ไม่บล็อกรายการ, แสดง "กำลังอ่าน pull request… n/m"); งานที่ยังไม่ถูกอ่านนับเป็น `unknown` ไม่ใช่ "ไม่มี PR" | `ade/workspaceCleanupBrowse.ts`, `ade/CleanupFilterBar.svelte`, `ade/cleanup.svelte.ts` |
| done | facet archived/comment ใน dialog (TriState only/hide จาก `archived_at` และ comment ที่ไม่ว่าง) รวมถึง blocker `running-terminal` (task ที่มี terminal tab เปิดอยู่จะไม่ถูกเสนอให้ลบ) | `ade/CleanupDialog.svelte`, `ade/CleanupFilterBar.svelte`, `ade/workspaceCleanupBrowse.ts` |
| done | facet pinned ใน dialog: task ที่ปักหมุดใน side bar ของโฟลเดอร์นั้นเป็น blocker `pinned` และถูกกรอง/เรียงได้; host/repo ยังไม่เปิดเพราะหน้าต่างหนึ่งมี repo เดียว | `ade/cleanup.svelte.ts`, `ade/workspaceCleanupScan.ts`, `ade/workspaceCleanupBrowse.ts` |
| done | กฎ `automationRuns` (task ที่ automation สร้าง: `origin = automation`) match เมื่อ agent ทำงานจบแล้ว; `orchestrationWorkers` (task ที่ agent อื่น dispatch: `dispatched_by`) match เมื่อ agent จบ **และงาน landed แล้ว** (`merged || unchanged`) ตาม Orca; งานที่อาจหาย (ไม่ commit, ไม่ push, ไฟล์ ignore) ยังกันไว้เหมือนกฎอื่น | `ade/workspaceCleanupScan.ts` `candidateInput` |
| done | run ตรวจซ้ำ target ทุกตัวก่อน `removeConfirmed` ด้วย `workspace_cleanup_inspect` ต่อ worktree (ไม่สแกนทั้งโปรเจกต์ใหม่) แล้ว evaluate ใหม่; task ที่เปลี่ยนสถานะหลังสแกนถูกข้ามและนับเป็น kept, inspect ล้มเหลวหยุดลูปและรายงาน failed โดยไม่ลบต่อ | `ade/workspaceCleanupScan.ts` `applyRechecked`/`candidateVerdict`, `ade/cleanup.svelte.ts`, `workspace_cleanup.rs` |
| done | สแกนและวัดขนาดไม่ใช้ global `AtomicBool` แล้ว: สองหน้าต่างสแกน/วัดพร้อมกันได้; frontend ยัง single-flight ต่อโฟลเดอร์ (`#inflight` ผูก root, ผลสแกนของโฟลเดอร์เก่าถูกทิ้ง; `measuring` ต่อหน้าต่าง) | `workspace_cleanup.rs`, `ade/cleanup.svelte.ts` |
| done | squash / rebase merge: scanner เทียบเนื้อหา — ไฟล์ทุกไฟล์ที่ branch แก้ (`git diff --name-only base...HEAD`) เหมือนกับใน base ทุกไฟล์ → นับเป็น merged และ commit ของมันไม่ใช่งานที่ยังไม่ push (`squashMerged`); ถ้า base แก้ไฟล์เหล่านั้นต่อภายหลังจะดูเหมือนยังไม่ merge ซึ่งมีผลแค่ "เก็บไว้" ไม่ใช้สถานะ PR จาก forge | `workspace_cleanup.rs` `content_in_base` |
| done | ตรวจ merge ผ่านสถานะ PR/MR ของ GitHub (`gh pr list`), GitLab (`agent::mr` ด้วย token ที่เก็บไว้, route ของ fork ครั้งเดียว) หรือ Bitbucket Cloud (`bitbucket.rs` ด้วย credential, เฉพาะ PR จาก repo นี้): นับเป็น merged (`prMerged`, commit ไม่ใช่งานที่ยังไม่ push) เฉพาะเมื่อ head ของ PR/MR ตรงกับ HEAD ของ worktree เป๊ะ — commit ที่ทำหลังจากนั้นเก็บไว้; ไม่มี gh/token/credential / error / timeout = ไม่มีข้อมูล (งบรวม 8 วินาที, ต่อคำขอไม่เกิน 4 วินาที) | `workspace_cleanup.rs` `MergedLookup`, `agent/mr.rs` `merged_head`, `bitbucket.rs` `merged_head` |
| done | Activity และ `lastRunAt` เก็บใน `localStorage` (`kingu.cleanup.activity:<root>`, versioned) จึงรอด restart; อ่านซ้ำก่อนเขียน/ก่อน `cleanup report` และฟัง `storage` event ให้หน้าต่างอื่นเห็น; read-modify-write ใช้ Web Lock ต่อโฟลเดอร์ (ถ้า WebView เก่าไม่มี API ยังอาจหายหนึ่งแถว); ข้อมูลเสียถูกซ่อมทีละแถวและไม่ทำให้ run ล้ม | `ade/autoCleanup.ts`, `ade/cleanup.svelte.ts`, `ade/cliBridge.svelte.ts` |
| done | กฎ `inactive` แบบ archive: evaluator คืน `archive`, run/dialog/CLI เรียก `adeTasks.archive` (ซ่อนจาก side bar; worktree, branch และ session ยังอยู่) และ Activity/receipt แยก `archived` จาก `removed` | `ade/workspaceCleanupScan.ts`, `ade/cleanup.svelte.ts`, `ade/CleanupDialog.svelte`, `crates/kingu-cli/src/client.rs` |
| n/a | Bitbucket Server/Data Center (self-hosted) ไม่รองรับ และไม่อยู่ในขอบเขต parity: Orca (`src/main/bitbucket/`, ตรวจที่ 9103a362) มีเฉพาะ Bitbucket Cloud API 2.0 | `bitbucket.rs` |
| done | Activity และ `lastRunAt` แยกตามโฟลเดอร์ (`kingu.cleanup.activity:<root>`, Web Lock ต่อโฟลเดอร์): run ของโปรเจกต์หนึ่งไม่เลื่อน auto-run ของอีกโปรเจกต์; run ที่เริ่มในโฟลเดอร์หนึ่งยังลง Activity ของโฟลเดอร์นั้นแม้ผู้ใช้สลับโฟลเดอร์กลางทาง และหยุดลบต่อทันทีเมื่อโฟลเดอร์เปลี่ยน; ประวัติเดิมที่เก็บไว้ใต้ key รวมไม่ถูกย้ายมา (ใช้เฉพาะตอนไม่มีโฟลเดอร์เปิดอยู่) | `ade/cleanup.svelte.ts`, `ade/CleanupDialog.svelte`, `ade/autoCleanup.ts` |
| done | เมนูที่ติดขอบล่าง/ขวา (task menu, Workspace options, Explorer context menu) วัดขนาดจริงแล้ว clamp ด้วย `menuLeft`/`menuTop` และเลื่อนภายในได้ (`max-height` + scroll) จึงกดรายการสุดท้ายได้แม้หน้าต่างเตี้ย | `workbench/menus.ts`, `workbench/PopupMenu.svelte`, `ade/AdeSidebar.svelte`, `workbench/ExplorerView.svelte` |
| done | `kingu task create --request-id`: id เดียวคืน task เดิม (`replayed: true`) ไม่สร้างงานซ้ำ; ledger `task-creates.json` รอด restart และ task เก็บ `request_id` ไว้ให้หน้าต่างอื่นหางานเดิมเจอเมื่อใบเสร็จหาย; ต่างจาก `workspaceCleanup.run` ที่มี ledger แยก (`cleanup-runs.json`) | `cli_server.rs` `task_create`, `cli_ledger.rs`, `agent/tasks.rs` `TaskMeta.request_id`, `ade/cliBridge.svelte.ts`, `kingu-cli/src/args.rs` |
