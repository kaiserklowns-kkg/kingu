# Snap: ระบบส่วนเสริมของ Kingu (แทน Extension)

- **สถานะ:** v1 · ระยะที่ 1 (Snap core) ทำเสร็จบน branch `ui/batch4`
- **ขอบเขต:** Kingu desktop (Tauri v2 + Svelte 5) ทั้งฝั่ง IDE (ทำงานแบบ VS Code) และ ADE (ทำงานแบบ Orca)
- **เอกสารที่เกี่ยวข้อง:** [`PLAN.md`](./PLAN.md), [`IDE-DESIGN.md`](./IDE-DESIGN.md), [`REA-analysis-vscode-orca-dbeaver.md`](./REA-analysis-vscode-orca-dbeaver.md)

---

## สารบัญ

1. [ที่มาและเป้าหมาย](#1-ที่มาและเป้าหมาย)
2. [หลักการออกแบบ](#2-หลักการออกแบบ)
3. [Snap คืออะไร](#3-snap-คืออะไร)
4. [Manifest: `snap.toml`](#4-manifest-snaptoml)
5. [สิ่งที่ Snap เพิ่มให้ IDE และ ADE](#5-สิ่งที่-snap-เพิ่มให้-ide-และ-ade)
6. [ที่มาของ Snap และลำดับความสำคัญ](#6-ที่มาของ-snap-และลำดับความสำคัญ)
7. [ความปลอดภัย](#7-ความปลอดภัย)
8. [การทำงานภายใน (runtime)](#8-การทำงานภายใน-runtime)
9. [หน้าจอและการใช้งาน](#9-หน้าจอและการใช้งาน)
10. [เทียบกับ VS Code Extension และ Orca](#10-เทียบกับ-vs-code-extension-และ-orca)
11. [แผนพัฒนา](#11-แผนพัฒนา)
12. [คำถามที่ยังเปิดอยู่](#12-คำถามที่ยังเปิดอยู่)

---

## 1. ที่มาและเป้าหมาย

Kingu รวม IDE (ทำงานแบบ VS Code) กับ ADE (ทำงานแบบ Orca: หนึ่งงาน = หนึ่ง git worktree ที่มี agent ทำงานอยู่) ไว้ในแอปเดียว หน้าตาเป็นของเราเอง แต่พฤติกรรมยึดตามทั้งสองระบบ

ทีมตัดสินใจ **ไม่ทำระบบ Extension แบบ VS Code** เพราะ:

| ปัญหาของ Extension แบบเดิม | ที่มา |
|---|---|
| โค้ดของ extension รันใน Node ภายในตัวแอป เข้าถึงไฟล์และเครือข่ายได้เต็มที่ | VS Code extension host |
| ต้องมี Node runtime อยู่ในแอป ซึ่ง Kingu (Tauri) ไม่มีโดยตั้งใจ | REA: Electron fuses ของ VS Code และ Orca ตั้งค่าหลวม |
| Extension ช่วยได้เฉพาะคนที่เขียนโค้ด ส่วน agent ใช้ไม่ได้ | VS Code |
| Skill / plugin ช่วยได้เฉพาะ agent ส่วนตัว IDE ใช้ไม่ได้ | Orca, Claude Code |

**เป้าหมายของ Snap:** ชิ้นส่วนที่ "เสียบ" (snap in) ครั้งเดียวแล้วใช้ได้ทั้ง **คนที่เขียนโค้ดใน IDE** และ **agent ใน ADE** ปลอดภัยกว่า extension และแชร์ให้ทั้งทีมใช้ชุดเดียวกันได้

---

## 2. หลักการออกแบบ

1. **หนึ่ง Snap ใช้ได้สองฝั่ง:** ทุกความสามารถของ Snap ต้องมีความหมายทั้งใน IDE และ ADE หรืออย่างน้อยฝั่งหนึ่งโดยไม่ขัดอีกฝั่ง
2. **ไม่มีโค้ดของ Snap รันในตัวแอป:** Snap เป็นข้อมูล (manifest, ไฟล์) หรือเป็นโปรเซสแยกที่ Rust เป็นคนเปิดให้ ไม่มี JavaScript ของ Snap รันใน WebView ของแอป
3. **ประกาศก่อนใช้:** สิ่งที่ Snap ทำได้และสิทธิ์ที่ต้องใช้ต้องอยู่ใน manifest ผู้ใช้เห็นก่อนอนุญาต
4. **เปิด repo แล้วไม่มีอะไรรันเอง:** Snap ที่มากับ repo ต้องได้รับความไว้วางใจ (trust) จากผู้ใช้ก่อนจึงจะทำงาน
5. **ใช้มาตรฐานที่มีอยู่:** เครื่องมือของ agent ใช้ MCP, ภาษาใช้ LSP + TextMate grammar, skill ใช้รูปแบบ `SKILL.md` เพื่อให้ Snap ใช้ของที่มีอยู่แล้วในโลกได้ทันที
6. **ทำทีละระดับ:** เริ่มจากสิ่งที่ไม่มีโค้ด (ปลอดภัยที่สุด) แล้วค่อยขยายไปโปรเซสแยก และหน้าจอเป็นลำดับสุดท้าย

---

## 3. Snap คืออะไร

Snap คือ **โฟลเดอร์หนึ่งโฟลเดอร์** ที่มีไฟล์ `snap.toml` อยู่ที่ราก ชื่อโฟลเดอร์ต้องตรงกับ `id` ใน manifest

```
go/
├── snap.toml          # manifest (จำเป็น)
├── skills/            # (ระยะที่ 2) SKILL.md สำหรับ agent
│   └── go-style/SKILL.md
├── syntaxes/          # (ระยะที่ 2) TextMate grammar
└── themes/            # (ระยะที่ 2) ธีม
```

---

## 4. Manifest: `snap.toml`

### 4.1 ตัวอย่างเต็ม (ระยะที่ 1)

```toml
id = "go"                       # ^[a-z0-9][a-z0-9-]{0,39}$ และต้องตรงกับชื่อโฟลเดอร์
name = "Go"
version = "0.1.0"
description = "งานรันเทสต์และเครื่องมือ Go สำหรับคนและ agent"

[permissions]                   # ประกาศไว้ให้ผู้ใช้เห็นก่อน trust (บังคับจริงในระยะที่ 2)
network = false
fs = "worktree"                 # "worktree" | "home"
secrets = []                    # ชื่อ secret ที่ต้องใช้ (ค่าเก็บใน Keychain ในระยะที่ 2)

[[tasks]]                       # งานที่รันใน terminal
id = "test"
title = "Run tests"
command = ["go", "test", "${setting:testFlags}", "./..."]

[[settings]]                    # ขึ้นในหน้าการตั้งค่าระบบเป็น snap.go.testFlags
key = "testFlags"
type = "string"                 # "string" | "boolean" | "number"
default = "-race"
description = "flags ที่ส่งให้ go test"

[mcp.gopls]                     # MCP server (stdio) ที่ส่งให้ agent ใช้เป็น tool
command = ["gopls", "mcp", "${setting:testFlags}"]
env = { GOFLAGS = "-mod=mod" }

[[skills]]                      # โฟลเดอร์ที่มี SKILL.md (รูปแบบ skill ของ Claude Code)
path = "skills/go-style"
```

### 4.2 กติกา

| ฟิลด์ | กติกา |
|---|---|
| `id` | ตัวพิมพ์เล็ก ตัวเลข และ `-` ยาวไม่เกิน 40 ตัว ต้องตรงกับชื่อโฟลเดอร์ |
| ฟิลด์ที่ไม่รู้จักระดับบนสุด | ถือเป็น error เพื่อให้เจอคำพิมพ์ผิดตั้งแต่แรก |
| `tasks[].command` | เป็น **argv** (array) ไม่ใช่ข้อความคำสั่ง shell ทุกอาร์กิวเมนต์ถูก quote ก่อนพิมพ์ลง terminal จึงไม่มีทางกลายเป็นคำสั่ง shell |
| `${setting:<key>}` | ใช้ได้ใน `tasks[].command`, `mcp.*.command` และค่าใน `mcp.*.env` ถ้าทั้งค่าเป็น placeholder จะแทนด้วยค่าเต็ม และตัดทิ้งเมื่อว่าง ถ้าอยู่ในข้อความยาวกว่าจะแทนเฉพาะข้อความ แทนครั้งเดียวไม่แทนซ้ำ key ต้องประกาศใน `[[settings]]` ถ้าชื่อโปรแกรม (อาร์กิวเมนต์แรก) แทนแล้วว่าง งานนั้นไม่รัน และ MCP server นั้นไม่ถูกส่ง |
| `skills[].path` | path ย่อยในโฟลเดอร์ snap (ห้าม `/` นำหน้า, `..`, ส่วนว่าง) ชื่อโฟลเดอร์สุดท้ายคือชื่อ skill (`a-z0-9-` ไม่เกิน 64 ตัว) ห้ามซ้ำ ไม่เกิน 32 ตัว ห้ามมี symlink ต้องมี `SKILL.md` ลึกไม่เกิน 8 ชั้น รวมไม่เกิน 256 ไฟล์ / 4 MB ต่อ snap ไฟล์ที่ขึ้นต้นด้วย `.` ถูกข้าม |
| `settings[].key` | ตัวอักษรและตัวเลข เริ่มด้วยตัวอักษร ได้ id เต็มเป็น `snap.<id>.<key>` |
| Snap ที่ manifest ผิด | ยังแสดงในรายการพร้อมข้อความ error แต่ไม่ได้เพิ่มอะไรเข้าระบบ |

---

## 5. สิ่งที่ Snap เพิ่มให้ IDE และ ADE

| ความสามารถ | ระยะ | ใน IDE (แบบ VS Code) | ใน ADE (แบบ Orca) |
|---|---|---|---|
| **Tasks** | 1 | คำสั่งใน Command Palette (`Snap: <ชื่อ>`) รันใน terminal ของ panel ล่าง ที่ราก folder | รันเป็นแท็บ terminal ใหม่ **ใน worktree ที่เลือกอยู่** |
| **Settings** | 1 | หมวด `Snaps` ในหน้าการตั้งค่าระบบ | ใช้ค่าชุดเดียวกัน |
| **MCP servers** | 1 | (ระยะที่ 2: เรียก tool จาก palette) | ส่งให้ agent ทั้งสองแบบ: SDK ใช้ option `mcpServers`, CLI ใช้ไฟล์ `--mcp-config` |
| **Skills** (`SKILL.md`) | 2 (ทำแล้ว) | แสดงในหน้า Snaps | agent แบบ timeline ได้ผ่าน option `plugins` ของ SDK, `claude` CLI ได้ผ่าน `--plugin-dir` ชื่อ skill เป็น `snap-<id>:<skill>` |
| **Language** (LSP + grammar + snippets) | 2 | ไฮไลต์, autocomplete, diagnostics | agent อ่าน diagnostics ได้ |
| **Themes / file icons** | 2 | ใช้ได้ | ใช้ได้ |
| **Views** (หน้าจอของ Snap) | 3 | iframe ที่ถูกกั้น คุยผ่าน postMessage | เช่นเดียวกัน |

**ตัวอย่าง Snap ที่ตั้งใจให้มี:**

| Snap | IDE ได้ | ADE ได้ |
|---|---|---|
| **Go** | `go test`, gopls | tool รันเทสต์, skill "วิธีเขียน Go ของทีม" |
| **Postgres** | query และดูผลลัพธ์ (แนวเดียวกับ DBeaver) | tool query DB ให้ agent โดยรหัสผ่านอยู่ใน Keychain |
| **Jira / Linear** | เปิด issue | ดึง issue มาเป็นงานใน Tasks และให้ agent อัปเดตสถานะ |

---

## 6. ที่มาของ Snap และลำดับความสำคัญ

| ที่มา | ตำแหน่ง | ความไว้วางใจ | ระยะ |
|---|---|---|---|
| **ผู้ใช้** | `<app config dir>/snaps/<id>/` (โฟลเดอร์เดียวกับ `settings.json` ของผู้ใช้) | ไว้ใจโดยปริยาย (ผู้ใช้วางเอง) | 1 |
| **Repo** | `<root>/.kingu/snaps/<id>/` (แชร์ผ่าน git) | **ต้อง trust ก่อน** | 1 |
| **Built-in** | มากับแอป (เช่น rust-analyzer และธีมที่ฝังอยู่ตอนนี้) | ไว้ใจ | 2 |
| **ทีม** | คลังกลางบน Kingu team server (Go) ทีมอนุมัติและตรึงเวอร์ชัน | ตามนโยบายทีม | 2 |

- id เดียวกันจาก repo และผู้ใช้: **repo ชนะเมื่อได้รับ trust แล้ว** เพราะเป็นข้อตกลงของโปรเจกต์ ก่อน trust Snap ของผู้ใช้ยังทำงานตามปกติ (repo ที่ไม่น่าไว้ใจปิดเครื่องมือของผู้ใช้ไม่ได้)
- การตั้งค่าของ Snap ผู้ใช้ตั้งได้เฉพาะระดับ User: `.kingu/settings.json` ของ repo จึงแทรกอาร์กิวเมนต์เข้าคำสั่งที่ผู้ใช้ไว้ใจไม่ได้
- **ระยะที่ 2:** `.kingu/snaps.lock` ตรึงเวอร์ชันและ hash ของ Snap ที่โปรเจกต์ใช้ ทุกคนและ agent ทุกตัวได้เครื่องมือชุดเดียวกัน

---

## 7. ความปลอดภัย

### 7.1 ระดับของ Snap

| ระดับ | สิ่งที่มี | ความเสี่ยง | การควบคุม |
|---|---|---|---|
| **1. ข้อมูล** | settings, theme, grammar, snippet, skill | ต่ำ | ตรวจ schema |
| **2. โปรเซสแยก** | task, MCP server, LSP | กลาง: รันคำสั่งบนเครื่อง | trust + สิทธิ์ที่ประกาศ + Rust เป็นคนเปิดโปรเซส |
| **3. หน้าจอ** | view | กลาง | iframe sandbox, CSP เข้ม, ไม่มี Tauri IPC |

### 7.2 Trust ของ Snap จาก repo

- การเปิดหรือ clone repo **ต้องไม่ทำให้อะไรใน `.kingu/snaps` รัน** (ป้องกัน repo ที่ไม่น่าไว้ใจ)
- Snap จาก repo จะแสดงในรายการพร้อมสิทธิ์ที่ประกาศ แต่ **ไม่เพิ่ม task และไม่ส่ง MCP ให้ agent** จนกว่าผู้ใช้กด trust
- ข้อมูล trust เก็บ **นอก repo** (โฟลเดอร์ config ของแอป) ผูกกับ path ของ folder + id ของ Snap + **SHA-256 ของ `snap.toml`**
- ถ้า manifest เปลี่ยน (เช่น ดึงโค้ดใหม่มาแล้วมีคนแก้ command) trust จะหลุดอัตโนมัติและต้องอนุมัติใหม่
- ถ้า Snap มี skill ค่า hash ที่ใช้ trust จะครอบคลุม `snap.toml` **และทุกไฟล์ของ skill** (skill คือคำสั่งให้ agent จึงต้องไม่เปลี่ยนลับหลังผู้ใช้) ส่วน Snap ที่ไม่มี skill ยังใช้ SHA-256 ของ `snap.toml` อย่างเดียว

### 7.3 การรันคำสั่ง

- คำสั่งเป็น argv แต่ละอาร์กิวเมนต์ถูก quote แบบ POSIX ใน Rust ก่อนพิมพ์ลง terminal ทั้งค่าการตั้งค่าและ prompt ของ agent จึงเป็นข้อมูลเสมอ
- **ระยะที่ 2:** บังคับสิทธิ์ที่ประกาศ เช่น จำกัดโฟลเดอร์ที่อ่านเขียนได้ และปิดเครือข่ายเมื่อ `network = false` (เทคนิคบน macOS ต้องศึกษาเพิ่ม เพราะ `sandbox-exec` ถูกเลิกใช้แล้ว) รวมถึงล้าง environment ก่อนเปิดโปรเซส และฉีดเฉพาะ secret ที่ประกาศจาก Keychain

### 7.4 สิ่งที่ Snap ทำไม่ได้ (โดยออกแบบ)

- รันโค้ดใน WebView ของแอป หรือเรียก Tauri command ของแอปเอง
- อ่าน token ของทีมใน Keychain ที่ไม่ได้ประกาศ
- ส่งข้อมูลโค้ดหรือ prompt ไปที่ team server (team server รับเฉพาะ metadata ตามนโยบายเดิม)

---

## 8. การทำงานภายใน (runtime)

```
snap.toml ──► Rust: snap.rs ──────────────► Svelte: snaps store
              • หา Snap จากผู้ใช้ + repo      • คำสั่งใน Command Palette (task)
              • ตรวจ manifest                 • หมวด Snaps ในหน้าตั้งค่าระบบ
              • คำนวณ trust (SHA-256)         • runTask → terminal (IDE หรือ ADE)
                                              • mcpServers() → agent
                                                    │
                       ┌────────────────────────────┴───────────────────────┐
                       ▼                                                    ▼
          ADE แบบ timeline (agent host, SDK)                 ADE แบบ terminal (CLI แบบ Orca)
          options.mcpServers                                 claude --mcp-config <ไฟล์ชั่วคราว>
```

- **Rust (`snap.rs`):** `snap_list` คืนรายการ Snap พร้อม error และสถานะ trust ส่วน `snap_trust` ตั้งหรือถอน trust ของ Snap จาก repo
- **Terminal ที่รันคำสั่ง:** `pty_spawn(..., slug?, run?)` เปิด shell ใน worktree ของงาน (หรือราก folder) แล้วพิมพ์คำสั่งที่ quote แล้วลงไป ใช้ร่วมกันทั้ง task ของ Snap และ agent CLI
- **Agent ใน ADE มีสองแบบ** (`kingu.agent.runMode`):
  - `terminal` (ค่าเริ่มต้น, แบบ Orca): รัน `kingu.agent.cli` เช่น `claude` หรือ `codex` ใน terminal ของ worktree โดยใส่ prompt เป็นอาร์กิวเมนต์สุดท้าย
  - `timeline`: รันผ่าน agent host (Claude Agent SDK) แสดงเป็น timeline พร้อมการ์ดขออนุญาต
- **การส่ง MCP ให้ agent:** แบบ timeline ส่งเป็น `mcpServers` ของ SDK ผ่าน agent host ส่วนแบบ CLI ต่อ `--mcp-config '<json>'` ท้ายคำสั่ง `claude` **หลัง prompt** (flag นี้รับหลายค่า ถ้าอยู่ก่อนจะกิน prompt) CLI อื่นยังไม่ได้ MCP
- **Skill → agent:** ก่อนเริ่ม agent ฝั่ง webview เรียก `snap_skill_plugins(ids)` Rust เขียน plugin หนึ่งโฟลเดอร์ต่อ Snap ที่ active ไว้ที่ `<app cache>/snap-plugins/<id>-<hash16>/` (`.claude-plugin/plugin.json` ชื่อ `snap-<id>` + `skills/<name>/…`) โดยคัดลอกจาก bytes ชุดเดียวกับที่ใช้คำนวณ hash ตอนตรวจ trust **ไม่เขียนอะไรลง repo หรือ worktree** แบบ timeline ส่งเป็น `plugins: [{ type: 'local', path, skipMcpDiscovery: true }]` ส่วน CLI ใช้ `--plugin-dir <dir>` (รับค่าเดียวต่อ flag) วางก่อน `--mcp-config`
- **โหลดใหม่อัตโนมัติ:** เมื่อ file watcher รายงานการเปลี่ยนแปลงใต้ `.kingu/snaps` จะโหลดรายการ Snap ใหม่หลังเงียบ 300ms ส่วน Snap ของผู้ใช้โหลดใหม่เมื่อหน้าต่างได้ focus
- **สถานะของ agent CLI:** `claude` เริ่มด้วย `--session-id <uuid>` (เก็บใน tasks.json เพื่อ `--resume` session เดิมหลังรีสตาร์ท) และ `--settings` ที่มี hooks (SessionStart, UserPromptSubmit, Pre/PostToolUse, Notification, Stop, SessionEnd) ซึ่งต่อ payload ลงไฟล์ `<app cache>/agent-hooks/<token>.jsonl` webview อ่านทุกวินาทีเพื่อแสดงสถานะ กำลังทำ / รอคุณอนุญาต / รอคุณ / จบ

---

## 9. หน้าจอและการใช้งาน

- **หน้าการตั้งค่าระบบ → หมวด Snaps:**
  - รายการ Snap พร้อมชื่อ เวอร์ชัน ที่มา (ผู้ใช้ / repo) คำอธิบาย และ error ถ้ามี
  - สิทธิ์ที่ประกาศ, task, setting และ MCP ที่ Snap นั้นเพิ่ม
  - ปุ่ม **Trust / Untrust** สำหรับ Snap จาก repo พร้อมคำเตือนว่าการ trust จะทำให้ Snap รันคำสั่งใน folder นี้ได้
  - ปุ่ม **Run** ต่อ task และปุ่ม **Reload**
- **Command Palette:** task ที่ trust แล้วขึ้นเป็น `Snap: <ชื่อ>: <task>` และมีคำสั่ง `Snap: Reload Snaps`
- **IDE:** task เปิด terminal ใหม่ใน panel ล่าง (มีรายการ terminal ทางขวาแบบ VS Code)
- **ADE:** task เปิดเป็นแท็บ terminal ใหม่ใน worktree ที่เลือก ถัดจากแท็บของ agent

---

## 10. เทียบกับ VS Code Extension และ Orca

| เรื่อง | VS Code Extension | Orca (plugin / skill) | Kingu Snap |
|---|---|---|---|
| ใครได้ประโยชน์ | คนเขียนโค้ด | agent | **ทั้งคู่** |
| โค้ดรันที่ไหน | Node ใน extension host | ใน agent / แอป | ไม่มีโค้ดในแอป มีแต่ข้อมูลและโปรเซสแยก |
| สิทธิ์ | ทำได้ทุกอย่าง | ขึ้นกับ agent | ประกาศใน manifest แล้วผู้ใช้อนุมัติ |
| Snap ที่มากับ repo | Workspace Trust (โหมดจำกัด) | — | trust ต่อ Snap ผูกกับ hash ของ manifest |
| แชร์ทั้งทีม | recommendations | — | `.kingu/snaps` และคลังของทีม (ระยะที่ 2) |
| มาตรฐานที่ใช้ | VS Code API | MCP, skills | MCP, LSP, TextMate, `SKILL.md` |

---

## 11. แผนพัฒนา

### ระยะที่ 1: Snap core (เสร็จแล้ว)

- [x] Terminal ที่รันคำสั่ง (quote ทุกอาร์กิวเมนต์ใน Rust) ใช้ได้ทั้ง IDE (หลาย terminal ใน panel) และ ADE (แท็บใน worktree)
- [x] ADE รัน agent ได้สองแบบ: CLI ใน terminal (แบบ Orca) และ timeline
- [x] `snap.toml`: อ่าน ตรวจ และค้นหาจากโฟลเดอร์ผู้ใช้และ repo
- [x] Trust ของ Snap จาก repo ผูกกับ SHA-256 ของ manifest
- [x] Task ใน Command Palette ที่รันได้ทั้งใน IDE และ ADE
- [x] Settings ของ Snap ในหน้าการตั้งค่าระบบ
- [x] หมวด Snaps ในหน้าการตั้งค่าระบบ
- [x] ส่ง MCP ของ Snap ให้ agent ทั้งแบบ SDK และ CLI

### ระยะที่ 2

- [x] `${setting:…}` ใน command/env ของ MCP
- [x] โหลด Snap ใหม่อัตโนมัติเมื่อ `snap.toml` เปลี่ยน
- [x] Skills (`SKILL.md`) ให้ agent ทั้งแบบ timeline และ `claude` CLI
- [x] MCP ให้ `codex` และ CLI อื่น; skill ให้ Claude, OpenCode และ Copilot แต่**ยังไม่ให้ skill กับ codex, gemini, amp และ cursor-agent** เพราะ CLI เหล่านั้นอ่าน skill จากโฟลเดอร์ config ของผู้ใช้เท่านั้น (เหตุผลราย CLI ใน `apps/desktop/src/lib/ade/agentProfiles.ts` หัวข้อ "MCP and skill formats of the other CLIs")
- ข้อจำกัดที่รู้: task ที่ trust แล้วอาจเรียก script ใน repo ที่เปลี่ยนได้โดย `snap.toml` ไม่เปลี่ยน (hash ครอบคลุม manifest และ skill เท่านั้น)
- [x] Language (LSP + grammar), ธีม และ built-in snap (`src/lib/snaps/builtinSnaps.json`, `contributions.ts`)
- [x] `.kingu/snaps.lock` และคลัง Snap ของทีมบน team server (`snapLock`, `GET/PUT /v1/snaps`)
- [x] บังคับสิทธิ์ที่ประกาศ และฉีด secret จาก Keychain (`snapModel.ts`, `src-tauri/src/snap_secrets.rs`)
- [x] เรียก tool ของ MCP จาก IDE (`src/lib/agent/mcpChat.svelte.ts` ผ่าน `mcp_query`)

### ระยะที่ 3

- [x] Views: หน้าจอของ Snap ใน iframe ที่ถูกกั้น (`SnapViewFrame.svelte`, `src-tauri/src/snap_view.rs`, `viewBridge.ts`)

ตรวจสถานะเทียบกับโค้ดล่าสุดเมื่อ 2026-11-21 (APP-AUDIT ระบุว่าส่วนนี้ล้าสมัย)

---

## 12. คำถามที่ยังเปิดอยู่

1. **ชื่อ "Snap"** ชนกับระบบแพ็กเกจของ Ubuntu (Canonical Snap) จะใช้ชื่อนี้ต่อหรือไม่
2. **ที่มาของ Snap:** ส่วนตัว / ทีม / repo ต้องมีครบทั้งสามตั้งแต่ระยะแรกหรือไม่
3. **Views:** ต้องให้ Snap เพิ่มหน้าจอเองได้เร็วแค่ไหน
4. **การบังคับสิทธิ์บน macOS:** จะใช้เทคนิคไหนแทน `sandbox-exec`
5. **CLI agent ที่รองรับ:** นอกจาก `claude` และ `codex` ต้องรองรับตัวไหนอีก (Orca รองรับ OpenCode ด้วย)
