# แผนพัฒนา: แอปที่รวม Code Editor (แบบ VS Code) และ AI Agent Orchestration (แบบ Orca)

- **วันที่:** 2026-10-16
- **เวอร์ชันเอกสาร:** v2 (เปลี่ยน stack เป็น **Svelte + Rust + Go + Bun + PostgreSQL + Tailwind**)
- **ชื่อโครงการ (ชั่วคราว):** `Kingu Studio` เปลี่ยนได้ภายหลัง
- **ที่มา:** ใช้ผลวิเคราะห์ด้วย REA ใน [`REA-analysis-vscode-orca-dbeaver.md`](./REA-analysis-vscode-orca-dbeaver.md)
- **สถานะ:** ร่าง รอทีมตัดสินใจในหัวข้อ [12](#12-การตัดสินใจที่ทีมต้องทำ)

> **วิธีอ่าน:** ข้อที่มีวงเล็บ *(จาก REA)* คือข้อมูลที่อ่านได้จากแอปจริง ส่วนข้อเสนอที่เหลือเป็นการออกแบบของเราเอง

### ประวัติการแก้ไข

| เวอร์ชัน | การเปลี่ยนแปลง |
|---|---|
| v1 | Electron + React + Node/TypeScript + SQLite |
| v2 | Tauri (Rust) + Svelte + Go + Bun + PostgreSQL + Tailwind เพิ่มส่วน server สำหรับทีม และเปลี่ยนหัวข้อความปลอดภัยจาก Electron fuses เป็น Tauri capabilities |
| **v3** | **ต่อยอดจาก repo `kaiserklowns-kkg/kingu` ที่มีอยู่** แทนการเริ่มใหม่ (ดูหัวข้อ 0) หัวข้อ 3, 4, 8 และ 9 เดิมถือเป็นเป้าหมายระยะยาว (Phase 3) |

---

## 00. การตัดสินใจ v4: พัฒนาใหม่ด้วย stack ของเรา (2026-10-17)

> **ทีมตัดสินใจ:** เขียนใหม่ด้วย **Tauri v2 (Rust) + Svelte 5 + Tailwind + Go + PostgreSQL + Bun** โดยให้ **ทำงานเหมือน VS Code (IDE) และ Orca (ADE) เดิม** repo เดิม (`kaiserklowns-kkg/kingu`) กลายเป็น **spec อ้างอิงพฤติกรรม** ไม่ใช่ฐานโค้ด หัวข้อ 0 ด้านล่าง (v3) จึงถูกแทนที่ เว้นข้อ G1–G2 ที่ยังต้องแก้ในตัวเก่าตลอดช่วงที่ยังมีผู้ใช้

### 00.1 สิ่งที่ "ไม่ต้องเขียนเอง" (ใช้ของเดิมที่เป็น open source)

| ส่วน | ใช้อะไร | License |
|---|---|---|
| Editor | Monaco (editor ตัวเดียวกับ VS Code) | MIT |
| Syntax highlight / ธีม | TextMate grammars และ theme JSON จาก `extensions/` ของ Code-OSS ผ่าน `vscode-textmate` + `vscode-oniguruma` | MIT |
| Language features | Language Server ของแต่ละภาษา (tsserver, pyright, gopls, rust-analyzer) ผ่าน LSP | ต่างกันไป |
| Debugger | Debug Adapter Protocol (js-debug, debugpy, delve) | ต่างกันไป |
| Terminal | xterm.js (frontend) + `portable-pty` (Rust) | MIT |
| Agent ของเรา | Arkai / `arkaid` (Bun) ใช้ต่อได้เลย ตรง stack อยู่แล้ว | ของเรา |
| ตรรกะของ ADE | อ่านจาก `kingu-intelligence/src/main` (MIT) แล้ว port เป็น Rust/Go | MIT |

### 00.2 ระดับความเหมือน (parity tiers)

| Tier | ความหมาย | ตัวอย่าง |
|---|---|---|
| **P0: ต้องเหมือน** | ลำดับการทำงานหลักที่ผู้ใช้ทำทุกวัน | ADE: worktree ต่องาน, รัน agent ใน terminal, สถานะ agent, review diff, PR/checks · IDE: เปิดโฟลเดอร์, explorer, แท็บ editor, ค้นหา, Source Control, terminal, command palette, LSP พื้นฐาน |
| **P1: เหมือนในเวอร์ชันถัดไป** | ฟีเจอร์ที่ใช้บ่อยแต่ไม่ใช่ทุกวัน | debugger, SSH worktree, GitHub/Linear/Jira, automations, usage/vault, mobile companion |
| **P2: ทดแทนด้วยวิธีอื่น** | ฟีเจอร์ที่ทำซ้ำไม่คุ้ม | VS Code extension ecosystem → plugin API ของเราเอง + LSP/DAP, Design Mode → Chromium ที่สั่งผ่าน Playwright แทน `<webview>` |

**ข้อควรรู้:** "เหมือน VS Code ทั้งหมด" รวมถึงการรัน VS Code extension ทำซ้ำไม่ได้ในเวลาที่สมเหตุสมผล จึงจัดไว้ P2

### 00.3 ขั้นต่อไป

1. ทำ **feature inventory** จาก repo เดิม: รายการพฤติกรรมของ Orca (`src/main/*`, หน้าจอใน `src/renderer`) และส่วนของ VS Code ที่อยู่ใน P0 แต่ละข้อจับคู่กับ tier และไฟล์อ้างอิง
2. ตั้ง **monorepo ใหม่** ตามหัวข้อ 8.4 (Tauri app, Rust crates, Go server, Svelte packages, Bun workspaces)
3. **Spike ใน Phase 0** (หัวข้อ 9): Monaco + TextMate ใน WKWebView, xterm.js + `portable-pty`, Rust adapter รัน Claude Code/Arkai ใน worktree, Go + PostgreSQL ขั้นต่ำ

## 0. แผน v3: ต่อยอดจาก repo ที่มีอยู่ (2026-10-16) — ถูกแทนที่ด้วยหัวข้อ 00

> ส่วนนี้แทนที่การตัดสินใจ "สร้างใหม่ด้วย Tauri" ในหัวข้อ 3 เพราะทีมเลือก **fork Code-OSS + นำ ADE (Orca ที่ rebrand) เข้ามา** ไปแล้ว ข้อมูลทั้งหมดมาจากการสำรวจ repo ที่ `/Users/bright/Kingu`

### 0.1 สภาพปัจจุบันของ repo

| ส่วน | ที่อยู่ | สถานะ |
|---|---|---|
| Kingu IDE (fork VS Code) | `/` | rebrand แล้ว (`product.json`: Kingu Intelligence, `ai.anthov.kingu`) และ sync กับ `microsoft/vscode` ผ่าน `build/kingu-sync/sync-upstream.ts` |
| Agents Window | `src/vs/sessions`, `src/vs/sessions/contrib/kingu` | port UI ของ ADE มาเขียนใหม่แบบ native แล้ว: Home, Agents, Vault, Skills, Activity, Usage, Tasks (GitHub/GitLab/Jira/Linear) และ Artifacts (`ORCA_UI.md`, `PORTING.md`) |
| ADE ที่นำเข้ามา | `kingu-orca/` | backend รันแบบ headless ใต้ `--agents` และคุยกันผ่าน `KinguOrcaChannel` ส่วน renderer React (10,128 ไฟล์) **ยังไม่ได้ฝังใน Agents Window**: เปิดเป็นหน้าต่างแยกเฉพาะเมื่อใช้ `--orca` (`src/vs/platform/kinguOrca/electron-main/kinguOrcaHost.ts`) และคอมเมนต์หัวไฟล์ยังบรรยายแบบที่ไม่ตรงกับโค้ด |
| ADE ต้นฉบับ | `kingu-intelligence/` | Electron + React มี `cloud/`, `mobile/` และแอปมือถือที่ขึ้น App Store แล้ว |
| Arkai | `arkai/` | `arkaid` (Bun) มี HTTP + SSE และระบบอนุญาต `ask`/`auto` ส่วนใน IDE รันเป็น `omp … acp` แล้วแปลงคำขออนุญาตเป็น tool confirmation ของ agent host (`src/vs/platform/agentHost/node/acp/acpAgent.ts`) |
| Stack เป้าหมาย | `kingu-intelligence/web` (SvelteKit + Bun), `core` (Rust), `services/relay` (Go) | **เป็นแค่โครงเปล่า**: `web` เป็น template ของ `sv`, `core` มีข้อความ "Phase 3" และ `relay` มีแค่ `main.go` |
| เอกสารสถาปัตยกรรม | `kingu-intelligence/docs/KINGU-ARCHITECTURE.md` | README อ้างถึง แต่ **ไม่มีไฟล์นี้ใน repo** |

### 0.2 ปัญหาที่พบเมื่อเทียบกับผล REA

| # | ปัญหา | หลักฐาน | ความรุนแรง |
|---|---|---|---|
| G1 | **การแพ็ก ADE ไม่ได้ตัด `cloud/` ออก** ทำให้ Terraform, Dockerfile และเอกสาร ops ติดไปใน app.asar ซึ่งเป็นปัญหาเดียวกับที่ REA พบใน Orca 1.4.226 | `kingu-intelligence/config/electron-builder.config.cjs` บรรทัด 249–326 ไม่มีคำว่า `cloud` | สูง (ทำง่าย) |
| G2 | **ไม่มีการตั้งค่า Electron fuses เลย** ทั้งใน fork และ ADE จึงใช้ค่าเริ่มต้นที่หลวม (RunAsNode, ไม่ตรวจความถูกต้องของ ASAR, รับ `--inspect`) | ค้นหา `@electron/fuses`, `flipFuses` และ `EnableEmbeddedAsarIntegrityValidation` ใน `build/` และ `kingu-intelligence/config` แล้วไม่พบ | สูง (ต้องทดสอบ เพราะ VS Code ใช้ `ELECTRON_RUN_AS_NODE` ในบางจุด) |
| G3 | **ไม่มีภาษาไทย** | locale มีแค่ en, es, fr, ja, ko, zh (`kingu-orca/shared/ui-locale.ts:13`) โดย `en.json` มี **16,120 key (~1 MB)** | กลาง (งานใหญ่) |
| G4 | ไม่มีเอกสาร dev setup สำหรับ Kingu และเอกสารสถาปัตยกรรมหายไป | ข้างบน | กลาง |
| G5 | คอมเมนต์ใน `kinguOrcaHost.ts` บรรยายการฝัง `WebContentsView` ซึ่งโค้ดไม่ได้ทำ | บรรทัด 13–31 เทียบกับ 260–292 | ต่ำ |

### 0.3 Workstreams

| WS | เป้าหมาย | ส่วนที่แตะ |
|---|---|---|
| **WS1 ความปลอดภัยของแพ็กเกจ** | แก้ G1 และ G2 แล้วให้ CI ใช้ REA ตรวจ build ทุก release (หัวข้อ 11) | `kingu-intelligence/config/electron-builder.config.cjs`, `build/gulpfile.vscode.ts`, build script ของ fuses |
| **WS2 UX ของ Agents Window** | นำแนวทางจาก prototype มาใช้ในโค้ดจริง: การ์ดตัดสินใจ (อนุญาต / ตอบ / ตรวจ), ปุ่ม "รอคุณ n" และการรับหรือไม่รับทีละไฟล์ก่อน PR | `src/vs/sessions/contrib/sessions/browser/blockedSessionsList.ts`, `chatContentParts/toolInvocationParts/*`, `contrib/kingu` |
| **WS3 ภาษาไทย** | เพิ่ม `th` ใน ADE (16k key) และ Language Pack ไทยฝั่ง IDE | `kingu-orca/shared/ui-locale.ts`, `kingu-intelligence/src/shared/ui-locale.ts` และ `locales/th.json` ทั้งสองชุด |
| **WS4 Arkai เป็น agent หลัก** | ปุ่มอนุญาตของ Arkai (`once`/`always`/`reject`) ใช้งานได้ครบผ่าน ACP และเลือก Arkai เป็นค่าเริ่มต้นได้ | `src/vs/platform/agentHost/node/acp/*`, `arkai/packages/arkaid` |
| **WS5 Stack เป้าหมาย (Phase 3)** | SvelteKit web client, Go relay/server + PostgreSQL และ Rust core ตามหัวข้อ 3–8 เดิม | `kingu-intelligence/web`, `services`, `core` |
| **WS6 เอกสาร** | เขียน `KINGU-ARCHITECTURE.md`, คู่มือ dev setup และแก้คอมเมนต์ G5 | `docs/`, `kingu-intelligence/docs/` |

### 0.4 ลำดับงานที่แนะนำ

1. **WS1-a:** ตัด `cloud/` ออกจากการแพ็ก ADE (แก้ 1 บรรทัด) แล้วตรวจด้วย `asar list` หลัง build
2. **WS6-a:** เขียนคู่มือ dev setup ได้แก่ Node 24.18.0, `npm i`, `npm run compile` (หรือ `watch`), `npm run build-kingu-orca`, `./scripts/code.sh --agents` และวิธีรัน test (`./scripts/test.sh --run …` กับ `bun test` ใน `arkai/`)
3. **WS1-b:** สำรวจว่า fork ใช้ `ELECTRON_RUN_AS_NODE` ตรงไหนบ้าง แล้วเปิด fuses ที่ปลอดภัยก่อน (ASAR integrity, OnlyLoadAppFromAsar, cookie encryption) จากนั้นค่อยพิจารณาปิด RunAsNode
4. **WS2-a:** ปุ่ม "รอคุณ n" บน title bar ของ Agents Window ใช้ข้อมูลจาก `blockedSessionsList`
5. **WS3-a:** เพิ่ม `th` เข้า `SUPPORTED_UI_LOCALES` พร้อม `th.json` ชุดแรก (เมนูหลัก, การ์ดตัดสินใจ และหน้าตั้งค่า) แล้วค่อยแปลส่วนที่เหลือเป็นรอบ ส่วนที่ยังไม่แปลแสดงเป็นภาษาอังกฤษ

### 0.5 วิธีทำงานใน repo

- **Branch:** แตก branch จาก `main` ต่อ workstream เช่น `ws1/exclude-cloud-from-asar` แล้วรวมผ่าน PR
- **ไฟล์ vendored:** ห้ามแก้ไฟล์ใน `kingu-orca/` โดยตรงถ้าเลี่ยงได้ เพราะ `MERGE.md` ระบุว่าเป็นโค้ดที่นำเข้ามา ให้แก้ที่ `kingu-intelligence/` แล้ว re-vendor ตามขั้นตอนใน `MERGE.md` ยกเว้นไฟล์ที่ทีมตกลงว่าแก้ซ้ำทั้งสองที่ได้ เช่น `ui-locale.ts`
- **Upstream:** หลัง sync จาก `microsoft/vscode` ให้รัน script rebrand ใน `build/kingu-brand/` ตาม `KINGU-REPOS.md`

---

## สารบัญ

1. [วิสัยทัศน์และขอบเขต](#1-วิสัยทัศน์และขอบเขต)
2. [บทเรียนจาก VS Code และ Orca](#2-บทเรียนจาก-vs-code-และ-orca)
3. [Stack ที่เลือกและหน้าที่ของแต่ละภาษา](#3-stack-ที่เลือกและหน้าที่ของแต่ละภาษา)
4. [สถาปัตยกรรมระบบ](#4-สถาปัตยกรรมระบบ)
5. [ฟีเจอร์และลำดับความสำคัญ](#5-ฟีเจอร์และลำดับความสำคัญ)
6. [UX/UI และ Design System](#6-uxui-และ-design-system)
7. [ความปลอดภัย (Security Baseline)](#7-ความปลอดภัย-security-baseline)
8. [Tech Stack ละเอียดและโครงสร้าง Repo](#8-tech-stack-ละเอียดและโครงสร้าง-repo)
9. [Roadmap](#9-roadmap)
10. [ทีม ความเสี่ยง และลิขสิทธิ์](#10-ทีม-ความเสี่ยง-และลิขสิทธิ์)
11. [การตรวจ release ด้วย REA](#11-การตรวจ-release-ด้วย-rea)
12. [การตัดสินใจที่ทีมต้องทำ](#12-การตัดสินใจที่ทีมต้องทำ)
13. [ขั้นตอนถัดไป](#13-ขั้นตอนถัดไป)

---

## 1. วิสัยทัศน์และขอบเขต

### 1.1 Vision

> แอป desktop ที่ให้นักพัฒนาสั่ง AI agent หลายตัวทำงานพร้อมกันได้อย่างปลอดภัย แล้วรีวิว แก้ไข และ merge งานของ agent ได้ในแอปเดียว โดยมี server กลางให้ทีมเห็นงานของกันและกัน

### 1.2 ปัญหาที่ต้องการแก้

| ปัญหาปัจจุบัน | ที่มา |
|---|---|
| ต้องสลับไปมาระหว่าง Orca (สั่ง agent) กับ VS Code (รีวิวและแก้โค้ด) | ตอนนี้ Orca ส่งงานต่อให้ VS Code ผ่านคำสั่ง `code` *(จาก REA)* |
| VS Code ไม่ได้ออกแบบมาให้คุม agent หลายตัวใน worktree แยกกัน | VS Code เน้น chat ใน sidebar *(จาก REA: setting `chat.*` ราว 401 key)* |
| Orca เป็นเครื่องมือส่วนตัว ทีมไม่เห็นภาพรวมงานของ agent ทุกคน | Orca ไม่มีระบบทีม (อนุมาน) |
| แอป Electron ขนาดใหญ่มาก | VS Code 902 MB, Orca 770 MB *(จาก REA)* |
| ไม่มี UI ภาษาไทยมาในตัว | Orca รองรับ 6 ภาษา และไม่มีภาษาไทย *(จาก REA)* |

### 1.3 กลุ่มผู้ใช้

1. **นักพัฒนาในทีม:** สั่ง agent ทำงาน รีวิว และแก้โค้ด
2. **Tech Lead:** ดูภาพรวมงานของทั้งทีมจาก server แล้วอนุมัติ merge
3. **(ระยะหลัง) PM หรือ QA:** สร้าง task จาก issue และติดตามผลผ่าน web dashboard

### 1.4 นอกขอบเขต (Non-goals) ในเวอร์ชันแรก

- ไม่ทำ extension marketplace
- ไม่ทำ real-time co-editing แบบ Live Share
- ไม่รัน agent บน cloud: agent ทำงานบนเครื่องผู้ใช้เท่านั้น และ server เก็บแค่ metadata
- ไม่ทำแอปมือถือ
- เริ่มที่ macOS arm64 ก่อน ส่วน Windows และ Linux ทำในระยะหลัง

---

## 2. บทเรียนจาก VS Code และ Orca

### 2.1 สิ่งที่ควรนำมาใช้

| แนวคิด | ได้มาจาก | หลักฐาน (REA) | วิธีนำมาใช้ |
|---|---|---|---|
| Workbench layout + Secondary Side Bar | VS Code | `workbench.secondarySideBar.*` | โครง layout หลัก และให้ Secondary Side Bar เป็นที่วาง agent |
| Command Palette / Quick Open | ทั้งคู่ | `QuickOpen`, `WorktreeJumpPalette` | ทุก action ต้องเรียกจาก palette ได้ |
| ระบบ accessibility signals และ verbosity | VS Code | `accessibility.signals.*` 41 key, `accessibility.verbosity.*` 37 key | event bus ส่งเสียงหรือ ARIA announcement ได้ตั้งแต่ต้น |
| ธีม High Contrast มืดและสว่าง | VS Code | `hc-black`, `hc-light` | มี 4 ธีมตั้งแต่ MVP |
| 1 งาน = 1 Git worktree | Orca | `WorktreeCreationPanel`, `BaseRefPicker` | เป็นแกนหลักของโมเดลงาน |
| Kanban แสดงสถานะ agent | Orca | `AgentKanbanBoard`, `AgentStateDot` | เป็นหน้าหลักของโหมด Board |
| Terminal host แยกโปรเซส | Orca | `Orca Terminal Host.app` | PTY อยู่ใน daemon ไม่ตายตาม UI |
| Daemon ที่มี protocol version | Orca | `daemonProtocolVersion: 45` | agent ทำงานต่อได้แม้ปิด UI และ UI ต่อกับ daemon เวอร์ชันเก่าได้ |
| shadcn design system + Tailwind + CSS variables | Orca | `components.json` style `new-york-v4` | ใช้ **shadcn-svelte** ซึ่งเป็นแนวคิดเดียวกันในฝั่ง Svelte |
| ตัวดูไฟล์หลายชนิด | Orca | Markdown, Mermaid, CSV, ipynb | ทำทีละชนิด เริ่มจาก Markdown และ diff |
| Onboarding และ setup checklist | Orca | `OnboardingFlow`, `SetupGuideModal` | ต้องปิดได้และไม่โผล่ซ้ำ |
| Policy สำหรับองค์กร | VS Code | โฟลเดอร์ `policies/` | ระยะหลัง: admin ตั้ง policy ผ่าน server |

### 2.2 สิ่งที่ควรหลีกเลี่ยง

| ปัญหาที่พบ | แอป | วิธีที่เราจะทำแทน |
|---|---|---|
| Electron fuses ตั้งค่าหลวม: `RunAsNode` เปิด, ASAR integrity ปิด, `--inspect` เปิด | VS Code, Orca | **ใช้ Tauri จึงไม่มี Node runtime ในแอป** ปัญหากลุ่มนี้หายไปทั้งหมด |
| ฝัง `cloud/`, Terraform และไฟล์ test มาใน `app.asar` | Orca | Tauri ฝัง frontend ที่ build แล้วเข้าไปใน binary และให้ CI ตรวจ allowlist |
| ขอสิทธิ์ macOS เกินจำเป็น | Orca | ขอเฉพาะสิทธิ์ที่มีฟีเจอร์ใช้จริง |
| `disable-library-validation` + `allow-dyld-environment-variables` | DBeaver | ห้ามใช้ |
| IPC จาก renderer 862 จุด แต่พบการตรวจผู้ส่งเพียง 9 จุด (ผลวิเคราะห์ไม่ครบ) | Orca | ใช้ Tauri command แบบ typed และกำหนด capability ต่อหน้าต่าง |
| ไม่มีภาษาไทย และไม่มี High Contrast | Orca, DBeaver | มีภาษาไทยและ HC ตั้งแต่ MVP |
| Setting มากเกินไป | VS Code, DBeaver | ค่าเริ่มต้นดี แยก Basic กับ Advanced และค้นหาได้ |

---

## 3. Stack ที่เลือกและหน้าที่ของแต่ละภาษา

### 3.1 ภาพรวม

| เทคโนโลยี | ใช้ที่ไหน | หน้าที่ |
|---|---|---|
| **Svelte 5** (SvelteKit แบบ static SPA) | Desktop UI + Web dashboard | UI ทั้งหมด ใช้ component ร่วมกันได้ทั้ง 2 ที่ |
| **Tailwind CSS v4** + shadcn-svelte | Desktop + Web | Design system และ tokens |
| **Rust** | Desktop | Tauri v2 shell, daemon `kingud`, PTY, Git worktree, file watcher, SQLite cache, Keychain |
| **Go** | Server | API กลางของทีม, sync, integration (GitHub/Linear/Jira webhook), auth และ audit |
| **PostgreSQL** | Server | ข้อมูลกลางของทีม เช่น project, task, run, review, audit และ member |
| **Bun** | Toolchain (+ sidecar ถ้าจำเป็น) | package manager, monorepo workspaces, test runner, script และ codegen รวมถึง sidecar ที่ compile เป็น binary สำหรับ agent adapter ที่ต้องใช้ JS SDK |

### 3.2 ทำไมไม่ใช้ Electron แล้ว

| | Electron (v1) | **Tauri v2 (v2)** |
|---|---|---|
| ขนาดแอป | ราว 200–900 MB (Orca 770 MB, VS Code 902 MB *จาก REA*) | ราว 10–30 MB เพราะใช้ WebView ของระบบ |
| หน่วยความจำ | สูง (Chromium + Node) | ต่ำกว่า |
| Node ในแอป | มี จึงต้องตั้ง fuses ให้ถูก | **ไม่มี** ฝั่ง backend เป็น Rust |
| Security model | fuses + contextIsolation + IPC ที่ต้องตรวจเอง | **capabilities/permissions ต่อหน้าต่าง** + CSP + typed command |
| Rendering engine | Chromium เหมือนกันทุก OS | WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux) **ต้องทดสอบทุก OS** |
| Monaco / xterm.js | ใช้ได้ | ใช้ได้ (ทดสอบใน WKWebView ช่วง Phase 0) |

### 3.3 ข้อเสนอการแบ่งหน้าที่ Rust กับ Go

ทั้ง Rust และ Go เขียน daemon ได้ ข้อเสนอคือ

> **Rust = ทุกอย่างบนเครื่องผู้ใช้ / Go = ทุกอย่างบน server**

| ทางเลือก | ข้อดี | ข้อเสีย |
|---|---|---|
| **A (แนะนำ):** daemon เป็น Rust | ฝั่ง local ใช้ภาษาเดียว แชร์ crate กับ Tauri ได้, ใช้ `portable-pty` ได้ และ build/sign ชุดเดียว | ทีม Rust ต้องแข็ง |
| B: daemon เป็น Go | Go เหมาะกับการคุมโปรเซส (goroutine, `creack/pty`) และใช้คนชุดเดียวกับทีม server ได้ | ฝั่ง local มี 2 ภาษา ต้องเซ็นและ notarize binary 2 ชุด และต้อง sync type ข้ามภาษา |

ถ้าทีมถนัด Go มากกว่า Rust ให้เลือก B ได้ โครงสร้างอื่นในแผนยังใช้ได้เหมือนเดิม

### 3.4 PostgreSQL ทำให้ต้องมี server

PostgreSQL ไม่เหมาะจะติดตั้งบนเครื่องผู้ใช้ทุกคน จึงออกแบบเป็น **local-first + sync**

- **บนเครื่องผู้ใช้:** SQLite ผ่าน `rusqlite`/`sqlx` เก็บสถานะของ daemon, event log และ cache ทำงานได้แม้ออฟไลน์
- **บน server:** PostgreSQL เป็นแหล่งข้อมูลกลางของทีม
- **Sync:** daemon ส่ง metadata ขึ้น server แบบ outbox pattern **ไม่ส่งโค้ดหรือ secret** ส่งเฉพาะชื่อ task, สถานะ, สรุป diff, ผลรีวิว และ token usage

---

## 4. สถาปัตยกรรมระบบ

### 4.1 ภาพรวม

```
                         ┌───────────────────────────────────────────┐
                         │ Server (Go)                               │
                         │  ┌──────────────┐   ┌──────────────────┐  │
  Web Dashboard ◄───────►│  │ API (REST/   │◄─►│ PostgreSQL       │  │
  (SvelteKit)    HTTPS   │  │ Connect RPC) │   │ - projects/tasks │  │
                         │  │ + SSE/WS     │   │ - runs/reviews   │  │
                         │  └──────┬───────┘   │ - audit/members  │  │
  GitHub / Linear / Jira │         │           └──────────────────┘  │
  webhooks ─────────────►│  Integrations worker                      │
                         └─────────┬─────────────────────────────────┘
                                   │ HTTPS (sync metadata only, OIDC token)
┌──────────────────────────────────┼──────────────────────────────────┐
│ Kingu Studio.app (Tauri v2)      │                                  │
│                                  │                                  │
│  ┌───────────────────┐  invoke/  │  ┌────────────────────────────┐  │
│  │ WebView (WKWebView)│  events  │  │ Tauri core (Rust)          │  │
│  │ Svelte 5 + Tailwind│◄────────►│  │ - window/menu/tray         │  │
│  │ Monaco + xterm.js  │ (typed,  │  │ - commands (capability-    │  │
│  └───────────────────┘ specta)   │  │   scoped)                  │  │
│                                  │  │ - keyring (Keychain)       │  │
│                                  │  └─────────────┬──────────────┘  │
│                                  │                │ Unix socket     │
│                                  │  ┌─────────────▼──────────────┐  │
│                                  └──│ kingud (Rust daemon,       │  │
│                                     │  launchd agent)            │  │
│                                     │ - Agent Supervisor         │  │
│                                     │ - PTY host (portable-pty)  │  │
│                                     │ - Worktree Manager (git)   │  │
│                                     │ - SQLite store + outbox    │  │
│                                     │ - LSP process manager      │  │
│                                     └─────────────┬──────────────┘  │
└───────────────────────────────────────────────────┼─────────────────┘
                                                    │ spawn (sandboxed)
                       ┌────────────────────────────┼───────────────┐
                       ▼                            ▼               ▼
               Claude Code CLI               Codex CLI      OpenCode / อื่นๆ
                       │
                       ▼
               git worktree: ~/.kingu/worktrees/<repo>/<task-id>
```

### 4.2 องค์ประกอบหลัก

| องค์ประกอบ | ภาษา | หน้าที่ | บทเรียนจาก |
|---|---|---|---|
| **Desktop UI** | Svelte 5 + TS | Board, Workspace, editor, diff, terminal และ settings | Orca UI *(จาก REA)* |
| **Tauri core** | Rust | หน้าต่าง, typed command, capability ต่อหน้าต่าง และ keyring | แก้ปัญหา IPC ของ Orca |
| **kingud** | Rust | คุม agent, PTY, worktree, SQLite, sync outbox และ LSP | `orcad-template`, `Orca Terminal Host` *(จาก REA)* |
| **CLI `kingu`** | Rust (crate เดียวกับ daemon) | สั่งงาน daemon จากเทอร์มินัล | `bin/orca` *(จาก REA)* |
| **Agent Adapter** | Rust trait (+ Bun sidecar ถ้าจำเป็น) | interface กลางสำหรับ agent แต่ละเจ้า | Orca รองรับ Claude, Codex และ OpenCode *(จาก REA)* |
| **API Server** | Go | auth, project, task, review, sync และ realtime | — |
| **Integrations worker** | Go | รับ GitHub/Linear/Jira webhook และ sync สถานะ PR และ checks | `ChecksPanel`, `LinearIcon` *(จาก REA)* |
| **Database** | PostgreSQL | ข้อมูลกลางของทีม | — |
| **Web Dashboard** | SvelteKit | Tech Lead และ PM ดูภาพรวม ใช้ component ร่วมกับ desktop | Orca มี `out/web` และ `MobilePage` *(จาก REA)* |

### 4.3 Daemon ↔ UI protocol

- **ช่องทาง:** Unix domain socket ที่ `~/Library/Application Support/Kingu/kingud.sock` ตั้ง permission `0600`
- **รูปแบบ:** JSON-RPC 2.0 หรือ length-prefixed MessagePack
- **Handshake:** แลก `protocolVersion` และ `minCompatibleVersion` แบบที่ Orca ทำ *(จาก REA: `attachableDaemonProtocolVersions` 1–45)*
- **Type:** ประกาศใน Rust แล้ว generate เป็น TypeScript ด้วย `specta`/`tauri-specta` ฝั่ง Svelte จึงได้ type ตรงกันเสมอ

### 4.4 Server API

- **Go:** ใช้ `net/http` (Go 1.22+ routing) หรือ `chi` ร่วมกับ **Connect RPC** (protobuf) จะได้ client ทั้ง Go, TypeScript และ Rust จาก schema เดียว
- **Realtime:** ใช้ SSE สำหรับ dashboard และ WebSocket ถ้าต้องสื่อสาร 2 ทาง
- **Auth:** OIDC (Google Workspace, Microsoft Entra หรือ GitHub) ร่วมกับ PKCE ใน desktop และเก็บ refresh token ใน Keychain
- **Multi-tenant:** ใช้ PostgreSQL **Row-Level Security** แยกข้อมูลตาม `org_id`

### 4.5 โมเดลข้อมูล (PostgreSQL)

```sql
-- ย่อ: แสดงเฉพาะคอลัมน์หลัก
create table orgs      (id uuid primary key, name text not null, created_at timestamptz default now());
create table members   (org_id uuid references orgs, user_id uuid, role text check (role in ('owner','lead','dev','viewer')),
                        primary key (org_id, user_id));
create table projects  (id uuid primary key, org_id uuid references orgs, name text, repo_url text, default_base_ref text);
create table tasks     (id uuid primary key, project_id uuid references projects, title text,
                        source text check (source in ('manual','github','linear','jira')), external_ref text,
                        status text check (status in ('backlog','running','needs_input','review','done','failed')),
                        branch text, assignee uuid, created_by uuid, created_at timestamptz default now(),
                        updated_at timestamptz default now());
create table agent_runs(id uuid primary key, task_id uuid references tasks, adapter text, model text,
                        machine_id text, started_at timestamptz, ended_at timestamptz, exit_reason text,
                        input_tokens bigint, output_tokens bigint, cost_estimate numeric(12,4));
create table run_events(id bigserial primary key, run_id uuid references agent_runs, ts timestamptz,
                        kind text, summary jsonb);           -- redacted, ไม่มีโค้ดหรือ secret
create table reviews   (id uuid primary key, task_id uuid references tasks, reviewer uuid,
                        decision text check (decision in ('approve','request_changes','comment')), body text,
                        created_at timestamptz default now());
create table audit_log (id bigserial primary key, org_id uuid, actor uuid, action text, target text,
                        meta jsonb, ts timestamptz default now());
-- + RLS policies ตาม org_id, index บน (project_id,status), (task_id), (org_id, ts)
```

- **Migration:** `goose` หรือ `atlas`
- **Query:** `sqlc` + `pgx/v5` ได้ query ที่ type-safe และไม่ต้องใช้ ORM
- **Realtime fan-out:** ใช้ `LISTEN/NOTIFY` ของ PostgreSQL ส่งเหตุการณ์ไปยัง SSE ใน MVP

### 4.6 Agent Adapter Contract (Rust)

```rust
#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;                       // "claude-code"
    async fn detect(&self) -> Result<Detection>;        // installed? version?
    async fn start(&self, opts: StartOpts) -> Result<RunHandle>;
    async fn send(&self, run: &RunHandle, input: String) -> Result<()>;
    async fn stop(&self, run: &RunHandle, reason: StopReason) -> Result<()>;
    fn events(&self, run: &RunHandle) -> BoxStream<'static, AgentEvent>;
}

pub struct StartOpts {
    pub cwd: PathBuf,               // ต้องอยู่ใต้ worktree root
    pub prompt: String,
    pub model: Option<String>,      // เช่น "claude-opus-5-5", "claude-sonnet-5-5"
    pub permissions: PermissionProfile,
    pub env_allowlist: Vec<String>, // ไม่ส่ง env ทั้งหมดให้ agent
}
```

- adapter ส่วนใหญ่ spawn CLI ของ agent แล้ว parse output ที่เป็น stream-JSON
- ถ้าต้องใช้ SDK ที่มีเฉพาะ JavaScript/TypeScript ให้เขียน sidecar ด้วย Bun แล้ว `bun build --compile` เป็น binary เดียว เซ็นรวมกับแอป แล้วสื่อสารผ่าน stdio JSON-RPC

---

## 5. ฟีเจอร์และลำดับความสำคัญ

### 5.1 MVP (P0)

| # | ฟีเจอร์ | ส่วนที่ทำ | เกณฑ์ว่าเสร็จ |
|---|---|---|---|
| 1 | เพิ่ม Project จากโฟลเดอร์ Git | Rust | ตรวจ repo และ remote ได้ |
| 2 | สร้าง Task → worktree + branch | Rust | เลือก base ref ได้ และตั้งชื่อ branch ตามรูปแบบ |
| 3 | รัน Claude Code ผ่าน adapter | Rust | stream ข้อความ, tool call และไฟล์ที่แก้แสดงใน UI |
| 4 | Kanban สถานะ task (local) | Svelte | อัปเดตเรียลไทม์จาก daemon |
| 5 | Agent ถามกลับ (`needs_input`) | Svelte + Rust | แจ้งเตือนระบบและตอบได้ |
| 6 | Diff review รับหรือยกเลิกต่อไฟล์และต่อ hunk | Svelte | ใช้คีย์บอร์ดล้วนได้ |
| 7 | Monaco editor + file explorer + quick open | Svelte + Rust | เปิด แก้ และบันทึกไฟล์ใน worktree ได้ |
| 8 | Integrated terminal | Rust (PTY) + xterm.js | PTY รอดเมื่อปิดเปิดหน้าต่าง |
| 9 | Commit / push / เปิด PR (GitHub) | Rust | token เก็บใน Keychain |
| 10 | ภาษาไทยและอังกฤษ | Svelte | แปลครบ 100% และ CI ตรวจ |
| 11 | ธีม Light / Dark / HC Light / HC Dark | Svelte + Tailwind | ผ่าน WCAG 2.2 AA (HC ผ่าน AAA) |
| 12 | Security baseline (หัวข้อ 7) | ทุกส่วน | ผ่าน checklist ใน CI |

> **Server (Go + PostgreSQL) เริ่มใน P1** เพื่อให้ MVP ฝั่ง desktop ใช้งานได้เร็ว ถ้าทีมต้องการเห็นงานของทีมตั้งแต่ MVP ให้ย้าย P1 ข้อ 1–3 ขึ้นมาก่อน (ดู D5)

### 5.2 เวอร์ชันถัดไป (P1): ทีมและ server

1. Go API + PostgreSQL + OIDC login
2. Sync task และ run metadata จาก daemon ขึ้น server (outbox)
3. Web dashboard (SvelteKit): Kanban ทั้งทีม และ run history
4. GitHub webhook: สถานะ PR และ checks
5. Linear และ Jira: ดึง issue มาสร้าง task
6. Adapter สำหรับ Codex และ OpenCode
7. LSP สำหรับ TypeScript, Python, Go และ Rust
8. Accessibility signals (เสียงและ ARIA live)
9. Dashboard token และค่าใช้จ่ายต่อ task, คน และ project

### 5.3 ระยะหลัง (P2)

- Policy สำหรับองค์กร เช่น จำกัด agent และ model ที่ใช้ได้ และกำหนด budget
- Remote/SSH worktree
- Debugger (DAP)
- Plugin API
- Windows และ Linux
- Audit export

---

## 6. UX/UI และ Design System

### 6.0 จุดยืนด้าน UX/UI

| ชั้น | ความเหมือนกับ VS Code / Orca |
|---|---|
| **ระบบ (เบื้องหลัง)** | เหมือนในหลักการ (worktree, daemon, adapter) แต่เขียนเองทั้งหมด |
| **UX (ลำดับการทำงาน)** | เหมือนเฉพาะสิ่งที่นักพัฒนาคุ้นมือ (`⌘K`, `⌘P`, คีย์ลัดของ editor, diff เขียว/แดง, branch/PR) ที่เหลือทำให้ง่ายลง |
| **UI (หน้าตา)** | ของเราเองทั้งหมด ไม่ลอกชื่อ โลโก้ ไอคอน หรือหน้าตาที่เป็นเอกลักษณ์ของ VS Code |

**สิ่งที่ทำให้ง่ายกว่าเดิม:**

| ปัญหาของเดิม (จาก REA) | แนวทางของเรา |
|---|---|
| Orca มีแนวคิดให้เรียนรู้เยอะ เช่น worktree, workspace, automation, artifact และ skill | ผู้ใช้เห็นแค่ **"งาน"** ระบบจัดการ worktree และ branch ให้เอง |
| VS Code มีพื้นที่บนจอ 5 ส่วนและ setting ด้าน chat ราว 400 key | มี **3 หน้าจอหลัก** และ setting แบบพื้นฐานไม่เกิน 20 ข้อ |
| DBeaver มีหน้าตั้งค่า 107 หน้า | ตั้งค่าครั้งเดียวตอนเริ่มใช้ ที่เหลือใช้ค่าเริ่มต้น |
| Orca มี modal และ tour หลายจุด | แนะนำแบบ inline ณ จุดที่ใช้ และปิดได้ถาวร |
| ต้องสลับไปมาระหว่าง Orca และ VS Code | ทำครบตั้งแต่สั่งงาน รีวิว จนถึง PR ในแอปเดียว |
| ไม่มีภาษาไทย | เขียนข้อความเป็นภาษาไทยตั้งแต่แรก ไม่ใช่แปลจากภาษาอังกฤษทีหลัง |

### 6.1 ลำดับการทำงานหลัก: จากงานถึง PR ใน 4 ขั้น

```
① สั่งงาน        ② รอ / ตอบคำถาม      ③ รีวิว             ④ ส่ง
"แก้บั๊ก login"  → Agent ทำงาน...    → ดูสิ่งที่เปลี่ยน   → [สร้าง PR]
(พิมพ์ หรือ       ถ้ามีคำถาม          ✓ รับ  ✗ ไม่รับ      ระบบ commit
 ดึงจาก issue)    แจ้งเตือนเด้งมา      ✎ แก้เอง             และ push ให้
```

ทุกขั้นมีปุ่มหลักปุ่มเดียวที่เห็นชัด ส่วนตัวเลือกขั้นสูง (base branch, model, permission) อยู่ใต้ "ตัวเลือกเพิ่มเติม"

### 6.2 Layout: IDE + ADE ในหน้าต่างเดียว

> **แก้ไขหลังทดสอบ prototype รอบแรก:** รอบแรกซ่อนโครงสร้าง IDE ไว้ทั้งหมด ผลคือดูไม่ออกว่าเป็น IDE หรือ ADE เลย จึงเปลี่ยนเป็น **ใช้โครงสร้าง IDE เป็นค่าเริ่มต้น** แล้วทำให้ง่ายด้วยการจัดลำดับ ภาษา และปุ่มตามบริบทแทน
>
> **ตัดสินใจรอบที่ 3:** แยกเป็น **2 โหมดในหน้าต่างเดียว** สลับได้จาก title bar และใช้ข้อมูลงานชุดเดียวกัน
> - **โหมด Agents (ADE):** ยึดโครงของ Orca ตามที่อ่านได้จากโค้ด Orca 1.4.227 ด้วย REA ได้แก่
>   - แถบซ้ายเป็นรายการ worktree แบบการ์ด (branch, สถานะ agent, +/−, ผล checks Passing/Failing/Pending)
>   - ตรงกลางเป็นแท็บ terminal ของ agent, editor และบอร์ด
>   - แถบขวามีแท็บ Explorer / Agents / Source Control / Checks
>   - สีและฟอนต์ใช้ token แบบ shadcn neutral และ Geist
> - **โหมดโค้ด (IDE):** ยึดโครงของ VS Code ได้แก่
>   - Activity bar, Primary Side Bar (Explorer / Search / Source Control / Agents), แท็บ editor + breadcrumb + minimap, Panel (Problems / Output / Terminal), Chat ใน Secondary Side Bar และ status bar
>   - สีใช้จาก theme "2026 Light/Dark" ของ VS Code 1.141 (`extensions/theme-defaults/themes/2026-*.json`)
> - **ส่วนที่เป็นของเราเอง:** การ์ดตัดสินใจภาษาไทย (อนุญาต / ตอบ / ตรวจ), ปุ่ม "รอคุณ n" และการรับหรือไม่รับทีละไฟล์ก่อนสร้าง PR
> - **ลิขสิทธิ์:** Code-OSS และ Orca เป็น MIT จึงใช้โครงสร้างและค่าสีได้ แต่ห้ามใช้โลโก้หรือชื่อ VS Code
>
> แผนผังด้านล่างเป็นของรอบที่ 2 ซึ่งถูกแทนด้วยการตัดสินใจรอบที่ 3 ข้างบนแล้ว

```
┌────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  Kingu / shop-web ▾   [ ค้นหาไฟล์ งาน หรือคำสั่ง ⌘K ]  [รอคุณ 2] [+ งานใหม่] │
├──┬─────────────────┬─────────────────────────────────┬──────────────────┤
│A │ AGENTS  ของฉัน|ทีม│ ▦ ภาพรวมงาน │ ± ตรวจงาน·task-14 │ login.ts │ ● แก้บั๊กหน้า login │
│g │ รอคุณ (2)        │                                 │ Claude · Opus 5.5 │
│e │ ● อัปเดต deps    │  Editor area                    │ ─ Grep "local…"  │
│n │   ⎇ kingu/task-14│  - ภาพรวมงาน (Kanban)            │ ─ Read login.ts  │
│t │ ● export CSV     │  - โค้ด (Monaco)                 │ ─ Edit login.ts  │
│s │ กำลังทำ (1)      │  - ตรวจงาน (diff + รับ/ไม่รับ + PR) │ [ขออนุญาตรันคำสั่ง]│
│  │ ● แก้บั๊ก login   │                                 │  อนุญาต | ไม่อนุญาต │
│F │ เสร็จแล้ว (1)     ├─────────────────────────────────┤                  │
│G │                 │ Terminal · task-12 │ ปัญหา (0)    │ [สั่ง Agent เพิ่ม…] │
├──┴─────────────────┴─────────────────────────────────┴──────────────────┤
│ ⎇ kingu/task-12 · ● Agent กำลังทำงาน · ✓ 0 ปัญหา      48k tokens · TS · ไทย · ซิงก์ ✓ │
└────────────────────────────────────────────────────────────────────────┘
```

| ส่วน | ได้แนวคิดจาก | หน้าที่ |
|---|---|---|
| Activity bar (Agents / ไฟล์ / การเปลี่ยนแปลง / ตั้งค่า) | VS Code | สลับมุมมองของแถบข้าง |
| แถบข้าง **Agents** (ค่าเริ่มต้น) | Orca | รายการงานของ agent จัดกลุ่ม **รอคุณ / กำลังทำ / เสร็จแล้ว** พร้อม branch แต่ละงาน และสลับ ของฉัน/ทีม ได้ |
| แท็บ editor | VS Code | เปิดได้ทั้ง ภาพรวมงาน (Kanban), ไฟล์โค้ด, ตรวจงาน (diff) และตั้งค่า |
| แผง Agent ด้านขวา | Orca + Claude Code | ไทม์ไลน์ของ tool call (Read/Edit/Bash/Grep), การขออนุญาตรันคำสั่ง, คำถาม และช่องสั่งงาน |
| แผงล่าง | VS Code + Orca | Terminal ของ agent ในแต่ละงาน และปัญหาจาก LSP |
| Status bar | VS Code | branch, สถานะ agent, ปัญหา, token และสถานะซิงก์ |

**ส่วนที่ทำให้ใช้ง่ายกว่าของเดิม:**
- **ปุ่ม "รอคุณ n" บน title bar:** กดแล้วพาไปงานถัดไปที่ต้องตัดสินใจ ไม่ต้องไล่หาเอง
- **ปุ่มหลักเปลี่ยนตามสถานะงาน:** อนุญาต / ตอบ / Commit และสร้าง PR
- **ใช้ภาษาไทยในทุกจุดที่เป็นการตัดสินใจ:** ส่วนชื่อ tool ใช้ภาษาอังกฤษตามที่นักพัฒนาคุ้น
- **ตั้งค่าเหลือหน้าเดียว:** ค่าขั้นสูงค้นหาจาก `⌘K`
- **โหมดโฟกัส:** ซ่อนแถบข้างและแผงล่าง เหลือแค่ editor กับ Agent
- **ภาษาที่ใช้ในแอป:** แยกข้อความไว้ใน i18n key ตั้งแต่แรก แต่เขียนต้นฉบับเป็นภาษาไทยก่อน

**Prototype:** ทำเป็นหน้าเว็บกดลองได้ เพื่อทดสอบลำดับการทำงานและภาษาไทยก่อนเริ่ม Phase 0 (ไม่ใช่โค้ด Svelte จริง)

### 6.2.1 Svelte UI Stack

| ส่วน | เลือกใช้ |
|---|---|
| Framework | Svelte 5 (runes) + SvelteKit `adapter-static` (SPA สำหรับ Tauri) |
| Components | **shadcn-svelte** (สร้างบน Bits UI ซึ่งจัดการ a11y และ focus ให้) |
| Styling | Tailwind CSS v4 + CSS variables |
| Icons | Lucide (`@lucide/svelte`) |
| Editor | `monaco-editor` (wrap เป็น Svelte component เอง โหลด worker ผ่าน Vite) |
| Terminal | `@xterm/xterm` + addon `fit`, `search` และ `web-links` |
| Virtual list | `@tanstack/svelte-virtual` สำหรับ log และ list ยาว |
| Form/validation | `zod` หรือ `valibot` |
| i18n | **Paraglide JS** (compile-time, type-safe และ tree-shake ได้) หรือ `svelte-i18n` |
| Markdown/Diagram | `marked` + `shiki`, Mermaid และ KaTeX |

### 6.3 Design Tokens (Tailwind v4 `@theme`)

```css
@theme {
  --font-sans: "Geist", "IBM Plex Sans Thai", "Noto Sans Thai", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", "IBM Plex Sans Thai Looped", monospace;
  --radius: 0.5rem;
}
:root            { --background:#ffffff; --foreground:#0a0a0a; --primary:#171717; --border:#e5e5e5; --focus-ring:#2563eb; }
.dark            { --background:#0a0a0a; --foreground:#fafafa; --primary:#e5e5e5; --border:#262626; --focus-ring:#60a5fa; }
.hc-light        { --background:#ffffff; --foreground:#000000; --primary:#0f4a85; --border:#000000; --focus-ring:#0f4a85; }
.hc-dark         { --background:#000000; --foreground:#ffffff; --primary:#ffd700; --border:#ffffff; --focus-ring:#ffd700; }
```

- Orca ใช้ Geist *(จาก REA)* ซึ่ง **ไม่มีอักษรไทย** จึงต้องมี fallback เป็น IBM Plex Sans Thai หรือ Noto Sans Thai
- ภาษาไทยต้องตั้ง `line-height` อย่างน้อย **1.5** และทดสอบกับคำอย่าง "ฎีกา", "ปั๊ม" และ "ญี่ปุ่น" ใน WKWebView

### 6.4 ภาษา (i18n)

- locale เริ่มต้น `th` และ `en` ใช้ message format ที่รองรับตัวแปรและพหูพจน์
- **วันที่และตัวเลข:** ใช้ `Intl` และให้ผู้ใช้เลือกปี พ.ศ. หรือ ค.ศ. ได้
- **การเรียงข้อความ:** ใช้ `Intl.Collator('th')`
- **การตัดคำภาษาไทย:** ใช้ `Intl.Segmenter('th', {granularity:'word'})` สำหรับเลือกคำและค้นหา
- **ข้อความจาก server:** Go ส่ง error code ไม่ส่งข้อความ ให้ UI แปลเอง
- **CI:** fail ถ้ามี key ที่ยังไม่แปล

### 6.5 Accessibility Checklist

| หัวข้อ | เป้าหมาย |
|---|---|
| คีย์บอร์ด | ทุก action ใช้ได้โดยไม่ต้องใช้เมาส์ และ focus มองเห็นชัด |
| Screen reader | ปุ่มที่เป็นไอคอนมี `aria-label` ทั้งภาษาไทยและอังกฤษ ทดสอบด้วย VoiceOver บน WKWebView |
| Live region | ประกาศเหตุการณ์ เช่น "Agent ทำงานเสร็จ", "Agent มีคำถาม" และ "Test ล้มเหลว" |
| Signals | เสียงแจ้งเหตุการณ์ ปิดหรือเปิดแยกรายการได้ (แบบ VS Code) |
| Motion | รองรับ `prefers-reduced-motion` |
| Contrast | ผ่าน AA ทุกธีม และธีม HC ผ่าน AAA |
| Forced colors | รองรับ `forced-colors: active` |
| Zoom | ซูม 50–200% โดย layout ไม่แตก |
| เครื่องมือ | `axe-core` ใน Playwright และ `svelte-check` (มี a11y warnings ในตัว) |

### 6.6 หลักการ UX

1. **คนตัดสินใจขั้นสุดท้ายเสมอ:** agent ห้าม push หรือ merge เองถ้าไม่ได้ตั้งค่าให้ทำ
2. **เห็นสิ่งที่ agent ทำทุกขั้น:** timeline ของ tool call และไฟล์ที่แก้
3. **ค่าเริ่มต้นดี ตัวเลือกน้อย**
4. **ไม่ขัดจังหวะ:** ใช้ toast หรือ badge และใช้ modal เฉพาะเรื่องที่ต้องตัดสินใจทันที
5. **กู้คืนได้:** action ที่ทำลายข้อมูลต้องยืนยันก่อนและมี undo
6. **บอกสถานะ sync ให้ชัด:** ผู้ใช้ต้องรู้ว่าข้อมูลไหนอยู่แค่บนเครื่อง และข้อมูลไหนส่งขึ้น server แล้ว

---

## 7. ความปลอดภัย (Security Baseline)

### 7.1 Desktop (Tauri v2)

| หัวข้อ | การตั้งค่า |
|---|---|
| Capabilities | กำหนดไฟล์ `capabilities/*.json` แยกต่อหน้าต่าง และอนุญาตเฉพาะ command ที่หน้านั้นใช้ |
| Plugin permissions | เปิดเฉพาะ plugin ที่ใช้ เช่น `fs` จำกัด scope ไว้ที่ worktree root และ **ไม่เปิด `shell:allow-execute` ให้ frontend** |
| CSP | `default-src 'self'; script-src 'self'; connect-src 'self' ipc: https://api.<domain>; worker-src 'self' blob:` (Monaco ต้องใช้ worker) |
| Isolation pattern | เปิด Tauri **isolation pattern** เพื่อกรอง IPC ก่อนถึง core |
| Remote content | ห้ามโหลด URL ภายนอกในหน้าต่างหลัก ถ้าจะเปิดลิงก์ให้ใช้ `opener` เฉพาะ `https:` และยืนยันกับผู้ใช้ |
| Command | ทุก command ตรวจ argument ใน Rust เช่น path ต้องอยู่ใต้ worktree root (canonicalize แล้วจึงเทียบ) |
| Secret | `keyring` crate (macOS Keychain) ห้ามเก็บ token ใน SQLite หรือ localStorage |
| Updater | Tauri updater ต้องเซ็นด้วย key ของเรา และดาวน์โหลดผ่าน HTTPS เท่านั้น |
| Devtools | ปิดใน release build |

> **สิ่งที่ Electron ต้องทำแต่ Tauri ไม่ต้อง:** Tauri ไม่มี `RunAsNode`, `NODE_OPTIONS`, `--inspect` และไม่มี ASAR ให้แก้ไข ปัญหาที่ REA พบใน VS Code และ Orca จึงไม่เกิดตั้งแต่ระดับสถาปัตยกรรม frontend ถูกฝังไว้ใน binary ที่เซ็นแล้ว

### 7.2 macOS Entitlements

| Entitlement | ขอหรือไม่ | เหตุผล |
|---|---|---|
| Hardened Runtime | ✅ | จำเป็นสำหรับ notarize |
| `cs.allow-jit` | ⏸ เฉพาะถ้า WKWebView ต้องใช้ (ตรวจใน Phase 0) | — |
| `cs.allow-unsigned-executable-memory` | ❌ | — |
| `cs.allow-dyld-environment-variables` | ❌ | ป้องกันการแทรก dylib |
| `cs.disable-library-validation` | ❌ | บทเรียนจาก DBeaver |
| `network.client` | ✅ (ถ้าใช้ App Sandbox) | sync กับ server |
| camera, microphone, bluetooth, usb, location | ❌ | ไม่มีฟีเจอร์ใช้ |

- **Binary ที่ต้องเซ็นด้วย Team ID เดียวกัน:** `kingud`, `kingu` CLI และ Bun sidecar (ถ้ามี)
- **launchd agent:** ใช้ `SMAppService` (macOS 13 ขึ้นไป) ไม่เขียน plist ลง `~/Library/LaunchAgents` เอง

### 7.3 Daemon และ Agent

| ความเสี่ยง | มาตรการ |
|---|---|
| โปรเซสอื่นต่อ socket ของ daemon | ตั้ง socket `0600`, ตรวจ peer UID (`getpeereid`) และตรวจลายเซ็นของ client ถ้าทำได้ |
| Agent แก้ไฟล์นอก worktree | ตรวจ path, จำกัด cwd และใช้ `sandbox-exec` profile หรือ container เป็นทางเลือก |
| Agent อ่าน secret | ส่ง env ให้ agent เฉพาะตามรายการที่อนุญาต และมีโหมดซ่อน `.env` |
| Prompt injection | แสดง tool call ที่เสี่ยง (`rm -rf`, `curl \| sh`, `git push --force`) ให้คนอนุมัติก่อน |
| ค่าใช้จ่ายเกิน | ตั้ง budget ต่อ task และต่อวัน (บังคับใช้ใน daemon และ server) |
| Audit | เก็บ event log ใน SQLite และส่ง summary ที่ลบ secret แล้วขึ้น `audit_log` |

### 7.4 Server (Go + PostgreSQL)

| หัวข้อ | การตั้งค่า |
|---|---|
| Auth | OIDC + PKCE, JWT อายุสั้น และ refresh token rotation |
| Authorization | ตรวจ role ใน Go **และ** ใช้ Row-Level Security ใน PostgreSQL |
| Data minimization | **ไม่รับ source code และไม่รับ secret** รับเฉพาะ metadata และ diff stats และให้ server reject payload ที่ใหญ่หรือผิด schema |
| Transport | TLS 1.3 และ HSTS |
| DB | แยก role (`app_rw`, `app_ro`, `migrator`), ใช้ `sslmode=verify-full` และเปิด backup + PITR |
| Webhook | ตรวจ HMAC signature ของ GitHub, Linear และ Jira |
| Supply chain | `govulncheck` ใน CI และ build ด้วย `-trimpath` |
| Rate limit | จำกัดต่อ user และต่อ org |

### 7.5 Build และ Supply Chain

- **Rust:** build ด้วย **`cargo auditable`** เพื่อฝังรายการ dependency ลงใน binary ให้ REA `inspect_rust_binary` ตรวจได้ และรัน `cargo deny` (license และ advisory) กับ `cargo audit`
- **Go:** รัน `govulncheck` ส่วน build info ฝังอยู่ใน binary อยู่แล้ว ให้ REA `inspect_go_binary` ตรวจได้
- **Bun/JS:** ใช้ `bun install --frozen-lockfile`, ตรวจ license, ทำ SBOM และตรวจ lockfile ใน CI
- **SBOM:** CycloneDX ครอบคลุม Rust, Go และ JS ทุก release
- **Allowlist:** ตรวจว่า frontend bundle ไม่มี source map ใน release, ไม่มีไฟล์ test และไม่มี `.env`

---

## 8. Tech Stack ละเอียดและโครงสร้าง Repo

### 8.1 Desktop (Rust)

| งาน | Crate |
|---|---|
| Shell | `tauri` v2, `tauri-plugin-{dialog,fs,opener,updater,notification,window-state,single-instance}` |
| Typed IPC | `specta` + `tauri-specta` (generate TypeScript types ให้ Svelte) |
| Async | `tokio` |
| PTY | `portable-pty` |
| Git | ใช้ `git` CLI สำหรับ worktree, push และ PR flow (พฤติกรรมตรงกับที่ผู้ใช้คุ้นเคยที่สุด) และใช้ `gix` สำหรับงานอ่านเร็ว เช่น status และ diff |
| File watcher | `notify` |
| DB local | `sqlx` (SQLite) หรือ `rusqlite` |
| Secret | `keyring` |
| Serialization | `serde`, `serde_json` และ `rmp-serde` (MessagePack) |
| LSP proxy | `async-lsp` หรือ proxy stdio ไปยัง WebView ผ่าน channel |
| Logging | `tracing` + `tracing-subscriber` |
| Error | `thiserror`, `anyhow` |

### 8.2 Server (Go)

| งาน | Package |
|---|---|
| HTTP / RPC | `net/http` + `connectrpc.com/connect` (หรือ `chi` + OpenAPI) |
| DB | `jackc/pgx/v5` + `sqlc` |
| Migration | `pressly/goose` หรือ `ariga.io/atlas` |
| Auth | `coreos/go-oidc` + `golang.org/x/oauth2` |
| Config | ตัวแปร environment + `caarlos0/env` |
| Logging | `log/slog` (JSON) |
| Observability | OpenTelemetry (`go.opentelemetry.io/otel`) |
| Background jobs | `riverqueue/river` (ใช้ PostgreSQL เป็นคิว จึงไม่ต้องมี Redis) |
| Test | `testing` + `testcontainers-go` (PostgreSQL จริง) |

### 8.3 Frontend และ Toolchain (Bun)

| งาน | เครื่องมือ |
|---|---|
| Package manager / workspaces | **Bun** |
| Dev server / build | Vite (รันด้วย `bunx --bun vite`) + SvelteKit |
| Unit test | `bun test` สำหรับ util และ logic, Vitest + `@testing-library/svelte` สำหรับ component |
| E2E | Playwright (web dashboard) และ WebDriver ของ Tauri (desktop) |
| Lint / format | `oxlint` หรือ ESLint, Prettier + `prettier-plugin-svelte` และ `svelte-check` |
| Codegen | สคริปต์ Bun เรียก `buf generate` (Connect) และ `tauri-specta` |
| Sidecar (ถ้ามี) | `bun build --compile` → binary เดียว เซ็นรวมกับแอป |

### 8.4 โครงสร้าง Repo

```
kingu-studio/
├─ apps/
│  ├─ desktop/                 # Tauri v2
│  │  ├─ src-tauri/            # Rust: Tauri core, commands, capabilities/
│  │  └─ src/                  # SvelteKit (adapter-static)
│  ├─ web/                     # SvelteKit dashboard (adapter-node หรือ static + API)
│  └─ server/                  # Go API + integrations worker
│     ├─ cmd/api/
│     ├─ cmd/worker/
│     ├─ internal/{auth,tasks,runs,reviews,sync,integrations}/
│     └─ db/{migrations,queries}/   # goose + sqlc
├─ crates/                     # Rust workspace
│  ├─ kingud/                  # daemon binary
│  ├─ kingu-cli/               # CLI binary
│  ├─ agent-adapters/          # trait + claude-code, codex, opencode
│  ├─ worktree/
│  ├─ pty-host/
│  ├─ protocol/                # daemon↔UI types (specta)
│  └─ store/                   # SQLite + outbox
├─ packages/                   # Bun workspaces (TS/Svelte)
│  ├─ ui/                      # shadcn-svelte components + tokens
│  ├─ i18n/                    # th, en messages (Paraglide)
│  ├─ editor/                  # Monaco wrapper + LSP client
│  ├─ terminal/                # xterm wrapper
│  └─ api-client/              # generated Connect client
├─ proto/                      # .proto ของ server API (buf)
├─ sidecars/                   # (ถ้ามี) Bun sidecar สำหรับ JS SDK
├─ tools/
│  ├─ release-verify.ts        # bun script เรียก REA ตรวจ build
│  └─ package-allowlist.ts
├─ Cargo.toml                  # Rust workspace
├─ go.work
├─ package.json                # Bun workspaces
└─ docs/adr/
```

### 8.5 Environment สำหรับนักพัฒนา

| เครื่องมือ | เวอร์ชัน |
|---|---|
| Rust | stable (pin ใน `rust-toolchain.toml`) |
| Go | 1.2x ล่าสุด (pin ใน `go.mod` toolchain) |
| Bun | 1.x ล่าสุด (pin ใน `package.json` `packageManager`) |
| PostgreSQL | 17+ (dev ผ่าน Docker หรือ `testcontainers`) |
| Xcode CLT | สำหรับเซ็นแอปและ build WebKit target |

ตัวอย่างคำสั่ง (`justfile` หรือ `bun run`):

```bash
bun install                 # JS deps ทั้ง monorepo
bun run dev:desktop         # tauri dev (Vite + Rust)
bun run dev:server          # go run ./apps/server/cmd/api
bun run db:migrate          # goose up
bun run codegen             # buf generate + tauri-specta
bun run test                # bun test + cargo test + go test ./...
bun run verify:release      # เรียก REA ตรวจ build (หัวข้อ 11)
```

---

## 9. Roadmap

แบ่งเป็นเฟส แต่ละเฟสมีเกณฑ์ผ่าน ระยะเวลาขึ้นกับจำนวนคนในทีม (ดูหัวข้อ 10.1)

### Phase 0: Spike และตัดสินใจ

1. **Tauri + Svelte + Monaco ใน WKWebView:** วัด performance เปิดไฟล์ 10k บรรทัด, ตรวจ IME ภาษาไทย และตรวจ VoiceOver
2. **xterm.js + `portable-pty` ผ่าน daemon:** วัด throughput และ latency ของ PTY ผ่าน socket
3. **Rust adapter รัน Claude Code CLI ใน worktree:** parse stream JSON แล้วแสดงใน Svelte
4. **Go API + PostgreSQL ขั้นต่ำ:** login ด้วย OIDC และ sync task 1 ประเภท
5. **ตัดสินใจ D1–D8** (หัวข้อ 12)

**เกณฑ์ผ่าน:** demo ใช้ได้ทั้ง 4 ข้อ และมี ADR บันทึกการตัดสินใจ

### Phase 1: Foundation

- โครง monorepo (Cargo, Go, Bun), CI matrix, การเซ็นแอปและ notarize
- daemon protocol + specta codegen, SQLite store และ PTY host
- Design system (shadcn-svelte + 4 ธีม) และ i18n th/en
- Server skeleton: auth, migration, RLS และ observability

**เกณฑ์ผ่าน:** แอปว่างที่เปิดได้ เซ็นแล้ว ผ่าน security checklist และ REA verify ผ่าน

### Phase 2: MVP (desktop)

- ฟีเจอร์ P0 ข้อ 1–12

**เกณฑ์ผ่าน:** ทีมภายในใช้แทน Orca + VS Code ได้ครบ 1 สัปดาห์

### Phase 3: Team (server)

- P1 ข้อ 1–5: sync, web dashboard และ integration
- โหลดเทสต์ server: 50 คนพร้อมกัน และ 500 run ต่อวัน

**เกณฑ์ผ่าน:** Tech Lead ดูงานทั้งทีมได้จาก dashboard และข้อมูลที่ sync ไม่มีโค้ดหรือ secret (ตรวจด้วย test)

### Phase 4: Beta และ Release

- P1 ที่เหลือ
- ตรวจ accessibility กับ VoiceOver และ axe
- Auto-update และ crash report (ผู้ใช้ต้องยินยอมก่อน)
- ทำ backup/restore drill ของ PostgreSQL

**เกณฑ์ผ่าน:** วัดผลตาม success metrics และ REA ตรวจ build สุดท้ายสะอาด

---

## 10. ทีม ความเสี่ยง และลิขสิทธิ์

### 10.1 ทีมขั้นต่ำที่แนะนำ

| บทบาท | จำนวน | ทักษะหลัก |
|---|---|---|
| Tech Lead | 1 | Rust + สถาปัตยกรรม + security |
| Rust (desktop/daemon) | 1 | Tauri, tokio, PTY และ git |
| Go (server) | 1 | Go, PostgreSQL, auth และ integration |
| Frontend (Svelte) | 1–2 | Svelte 5, Tailwind, Monaco และ a11y |
| UX/UI Designer | 0.5–1 | design system, ภาษาไทย และ accessibility |
| DevOps / Platform | 0.5 | CI, การเซ็นแอป, deploy server, PostgreSQL ops และ REA verify |
| QA | 0.5 | E2E และ a11y |

> Stack นี้ใช้ภาษาหลัก **4 ภาษา** (Rust, Go, TypeScript/Svelte และ SQL) ทีมเล็กจะรับภาระ context switching สูง ถ้าทีมมีไม่ถึง 4 คน แนะนำทางเลือก B ในหัวข้อ 3.3 (Go daemon) เพื่อลดเหลือ Go + TS ฝั่ง backend และเก็บ Rust ไว้เฉพาะ Tauri shell บางๆ หรือเลือกทางกลับกัน

### 10.2 ความเสี่ยง

| ความเสี่ยง | โอกาส | ผลกระทบ | การลดความเสี่ยง |
|---|---|---|---|
| WKWebView ต่างจาก Chromium จน Monaco, xterm หรือ IME ภาษาไทยมีบั๊ก | กลาง | สูง | ทดสอบใน Phase 0 และมี fallback เป็น CodeMirror 6 |
| WebView ต่างกันบน Windows และ Linux | สูง (ตอนขยาย OS) | กลาง | จำกัด MVP ที่ macOS และทำ E2E matrix ก่อนขยาย |
| CLI ของ agent เปลี่ยน output format | สูง | สูง | adapter + contract test + pin เวอร์ชัน |
| ภาษาหลายตัวทำให้ทีมช้า | กลาง | สูง | แบ่งความรับผิดชอบชัดเจน, codegen type ข้ามภาษา และ ADR |
| Sync ส่งข้อมูลอ่อนไหวขึ้น server โดยไม่ตั้งใจ | กลาง | สูง | ทำ schema allowlist ใน daemon และ server พร้อม test ว่า payload ไม่มีโค้ดหรือ secret |
| PostgreSQL ops (backup, upgrade) | กลาง | กลาง | ใช้ managed PostgreSQL (เช่น Cloud SQL, RDS, Neon) หรือมี runbook |
| Bun เข้ากันไม่ได้กับบาง package | ต่ำ–กลาง | ต่ำ | ใช้ Bun เป็น package manager และ script ถ้า package ใดมีปัญหาให้รันด้วย Node ได้ |
| Scope บาน | สูง | สูง | ยึด non-goals ในหัวข้อ 1.4 |

### 10.3 ลิขสิทธิ์

| ซอฟต์แวร์ | License | ข้อควรระวัง |
|---|---|---|
| Orca (ใช้เป็นแบบอย่าง) | MIT (Copyright 2026 Lovecast Inc.) *(จาก REA)* | Orca เป็น React/Electron จึงต้องเขียนใหม่เกือบทั้งหมดใน Svelte/Rust ถ้านำส่วนใดมาใช้ต้องคง copyright notice |
| VS Code / Code-OSS | MIT (source) | ห้ามใช้ชื่อและโลโก้ VS Code และใช้ VS Code Marketplace ไม่ได้ |
| Tauri | MIT / Apache-2.0 | — |
| Svelte, SvelteKit, Tailwind, shadcn-svelte, Bits UI | MIT | — |
| Monaco, xterm.js | MIT | — |
| PostgreSQL | PostgreSQL License | — |
| Go, Rust, Bun | BSD / MIT / Apache-2.0 / MIT | — |
| Geist, IBM Plex Sans Thai, Noto Sans Thai | SIL OFL | — |

ให้ `cargo deny`, `go-licenses` และตัวตรวจ license ของ JS สร้าง `THIRD_PARTY_NOTICES` อัตโนมัติ

### 10.4 Success Metrics

| ตัวชี้วัด | เป้าหมาย Beta |
|---|---|
| เวลาจากสร้าง task ถึงเปิด PR | ลดลง ≥ 30% เทียบกับ Orca + VS Code |
| งานที่ทำในแอปโดยไม่ต้องสลับไป VS Code | ≥ 80% |
| ขนาดแอป | ≤ 50 MB (เทียบกับ Orca 770 MB) |
| หน่วยความจำขณะไม่ได้ทำงาน (UI + daemon) | ≤ 300 MB |
| Crash-free sessions | ≥ 99.5% |
| ผล axe-core | ไม่มีปัญหาระดับ serious หรือ critical |
| UI ภาษาไทย | ครอบคลุม 100% |
| API p95 latency | ≤ 200 ms |

---

## 11. การตรวจ release ด้วย REA

ใช้ REA ตรวจ build ของเราเองแบบเดียวกับที่ตรวจ VS Code, Orca และ DBeaver และให้ CI รันก่อนทุก release

| สิ่งที่ตรวจ | REA tool | เกณฑ์ผ่าน |
|---|---|---|
| Code signature และ entitlements ของ app, `kingud`, `kingu` และ sidecar | `open_binary` → `inspect_signature` | Team ID เดียวกัน, Hardened Runtime เปิด และ entitlements ตรงกับ allowlist ในหัวข้อ 7.2 |
| Mach-O: dependency, rpath และ load command | `inspect_macho` | ไม่มี rpath ที่ชี้ออกนอก bundle และไม่มี dylib แปลกปลอม |
| Dependency ของ Rust (cargo-auditable) | `inspect_rust_binary` | ตรงกับ `Cargo.lock` และไม่มี crate ที่ติด advisory |
| Build info ของ Go server | `inspect_go_binary` | Go version และ module ตรงกับที่ pin ไว้ และมี `-trimpath` |
| Frontend bundle ที่ฝังใน binary | `search_strings` / `list_strings` | ไม่มี path ภายในเครื่อง dev, ไม่มี `.env`, ไม่มี secret pattern และไม่มี source map |
| Info.plist | `inspect_plist` | Bundle ID, เวอร์ชัน และ usage description ตรงกับที่ขอสิทธิ์ |

สคริปต์ `tools/release-verify.ts` (Bun) เรียก REA CLI (`npx -y rea-agents@<pinned> …` หรือ `rea` ที่ติดตั้งไว้) แล้วเก็บ Evidence ID แนบไว้กับ release

---

## 12. การตัดสินใจที่ทีมต้องทำ

| # | คำถาม | ข้อเสนอเริ่มต้น |
|---|---|---|
| D1 | daemon ใช้ Rust หรือ Go | **Rust** (ทางเลือก A) ถ้าทีม Rust มีน้อยให้ใช้ Go |
| D2 | Agent ตัวแรกที่รองรับ | Claude Code |
| D3 | แพลตฟอร์มแรก | macOS arm64 |
| D4 | i18n library ฝั่ง Svelte | Paraglide JS |
| D5 | Server เริ่มใน MVP หรือ P1 | **P1** (desktop ใช้งานได้ก่อน) |
| D6 | Host server ที่ไหน (managed PostgreSQL / on-prem) | Managed PostgreSQL + container (Cloud Run / Fly / ECS) หรือ on-prem ถ้ามีข้อกำหนดด้านข้อมูล |
| D7 | API style ระหว่าง REST + OpenAPI กับ Connect RPC | Connect RPC (generate client ให้ TS, Go และ Rust จาก schema เดียว) |
| D8 | ใช้ Bun แค่เป็น toolchain หรือใช้เป็น runtime ใน production ด้วย | toolchain + sidecar เท่าที่จำเป็น |
| D9 | ชื่อผลิตภัณฑ์ | — |

---

## 13. ขั้นตอนถัดไป

1. ทีมรีวิวแผน v2 แล้วตัดสินใจ D1–D9
2. ตั้ง monorepo ตามหัวข้อ 8.4 และเขียน ADR-001 (stack และการแบ่งภาษา), ADR-002 (security baseline) และ ADR-003 (sync data policy)
3. เริ่ม Phase 0 ด้วย spike 4 เรื่องในหัวข้อ 9
4. ใช้ REA ศึกษา Orca ต่อแบบเจาะจุด เพื่อเป็นแบบอย่างของ daemon และ adapter:
   - `out/main` ส่วนจัดการ worktree และ agent launch
   - protocol ของ daemon (`orcad-template`)
   - วิธี parse output ของ Claude Code และ Codex
5. ทำ prototype หน้าจอ Board และ Workspace ใน Svelte พร้อมธีมภาษาไทย เพื่อทดสอบกับทีม
