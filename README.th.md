# Kingu

[English README](README.md) · **ภาษาไทย**

**Kingu Studio** คือ IDE และ Agentic Development Environment (ADE) ในหน้าต่างเดียว
มีตัวแก้ไขโค้ดสไตล์ VS Code สำหรับงานที่ลงมือเขียนเอง และพื้นที่สำหรับรัน coding agent
ใน git worktree ของแต่ละงาน ตรวจทานการเปลี่ยนแปลง และส่งงานออกเป็น pull request

> ภาพหน้าจอกำลังอัปเดตให้ตรงกับเวอร์ชันปัจจุบัน

## สารบัญ

- [Kingu คืออะไร](#kingu-คืออะไร)
- [ภาพหน้าจอ](#ภาพหน้าจอ)
- [ความสามารถ](#ความสามารถ)
- [โครงสร้างโปรเจกต์](#โครงสร้างโปรเจกต์)
- [สิ่งที่ต้องมี](#สิ่งที่ต้องมี)
- [เริ่มต้นพัฒนา](#เริ่มต้นพัฒนา)
- [คำสั่งที่ใช้บ่อย](#คำสั่งที่ใช้บ่อย)
- [ทีมเซิร์ฟเวอร์และเว็บแดชบอร์ด](#ทีมเซิร์ฟเวอร์และเว็บแดชบอร์ด)
- [เอกสารเพิ่มเติม](#เอกสารเพิ่มเติม)
- [สัญญาอนุญาต](#สัญญาอนุญาต)

## Kingu คืออะไร

Kingu รวมสองเครื่องมือไว้ด้วยกัน:

- **IDE** สำหรับเขียนโค้ดเอง ด้วย Monaco editor, TextMate themes, Explorer, ค้นหา,
  Source Control, terminal ในตัว, LSP และหน้าตาแบบ VS Code
- **ADE** สำหรับทำงานกับ agent แต่ละงานแยก worktree, ดูสถานะ agent, review diff,
  จัดการ PR/checks และส่งต่องานระหว่าง session

หน้าต่างเดียวสลับบริบทได้ด้วย `⇧⌘A` (macOS) หรือ `Ctrl+Shift+A` โดยไม่ต้องเปิดแอปหลายตัว

## ภาพหน้าจอ

อยู่ระหว่างอัปเดตภาพหน้าจอให้ตรงกับเวอร์ชันปัจจุบัน จะเพิ่มกลับมาที่นี่ภายหลัง

## ความสามารถ

### IDE

- Monaco editor พร้อม TextMate themes, แท็บ, split editor, minimap และ Markdown preview
- Explorer, ค้นหา, Source Control, extensions และ terminal ในตัว (xterm)
- Status bar แบบ VS Code: เลือก branch, sync/publish, problems, cursor, selection,
  indentation, encoding, line endings และภาษา
- Arkai assistant panel ข้างตัวแก้ไข
- ไอคอนชุด Phosphor ทั้งแอป

### ADE (Agents)

- หนึ่งงานต่อหนึ่ง git worktree พร้อม sidebar แบบ Orca สำหรับโปรเจกต์และ workspace
- Sidebar กรองงานได้: ซ่อนงานที่ sleep, automation, CLI-created, detached HEAD
  และเลือกแสดงเฉพาะงานที่ active
- Right sidebar: Explorer, Agents, Source Control, Checks, Ports และ Review
- Agents: ดู session ของงานและ session ของ Claude Code/Codex/Gemini พร้อม resume
  และ hand-off ไปยังงานใหม่
- Source Control: commit พร้อมข้อความจาก AI, push/pull/sync/rebase, commit graph,
  diff, สร้าง PR และแก้ conflict
- Checks: สถานะ PR, merge, log ของ check และ review thread
- Floating workspace (`⌥⌘A`): terminal และโน้ต Markdown ที่ลอยเหนือทุกหน้า
- Usage: แสดงการใช้งาน Claude และ Codex ใน status bar พร้อม popover รายละเอียด

### Workspace Cleanup

- ตั้งกฎล้าง worktree ที่ไม่ใช้แล้ว พร้อม preview ก่อนรันจริง
- ตรวจงานที่ถูก archive, pinned, มี terminal ทำงานอยู่ หรือมี branch ที่ยังไม่ merge
- รันซ้ำได้อย่างปลอดภัยด้วย `--request-id` และเก็บ receipt ของแต่ละรอบ
- ใช้ได้ทั้งจากหน้าตั้งค่าและ CLI

### ทีม

- Team server รับเฉพาะ **metadata** ของงาน เช่น ชื่อ สถานะ branch, agent, model,
  จำนวนบรรทัดที่เพิ่ม/ลบ และเวลา
- ไม่ส่งโค้ด, diff, transcript หรือ secret ขึ้นเซิร์ฟเวอร์
- เว็บแดชบอร์ดแสดงบอร์ดงานและประวัติการรันแบบเรียลไทม์

### CLI

คำสั่ง `kingu` ควบคุมแอปที่กำลังรันอยู่ได้ เช่น:

```bash
kingu task create "แก้อาการล็อกอินค้าง" --prompt "ตรวจ session timeout"
kingu cleanup preview
kingu cleanup run --request-id review-2026-11-20
```

### ภาษา

- UI สองภาษา: อังกฤษและไทย เลือกได้ใน Settings → Appearance → Language
- เอกสารนี้เป็นฉบับภาษาไทย ฉบับอังกฤษอยู่ที่ [README.md](README.md)

## โครงสร้างโปรเจกต์

Stack: **Tauri v2 (Rust) · Svelte 5 + Tailwind v4 · Go · PostgreSQL · Bun**

| Path | หน้าที่ |
| --- | --- |
| `apps/desktop` | แอปเดสก์ท็อป: SvelteKit (SPA) UI และ Tauri shell (`src-tauri/`) |
| `apps/server` | Team server (Go + PostgreSQL): metadata ของงาน, token และ live events |
| `apps/web` | เว็บแดชบอร์ดทีม (SvelteKit + adapter-node): บอร์ดและประวัติการรัน |
| `apps/agent-host` | Agent host sidecar |
| `crates/kingu-cli` | คำสั่ง `kingu` สำหรับควบคุมแอป |
| `crates/kingu-ptyd` | PTY daemon สำหรับ terminal |
| `docs` | เอกสารออกแบบ, parity และ mechanics |
| `assets/screenshots` | ภาพหน้าจอสำหรับ README (รออัปเดต) |

## สิ่งที่ต้องมี

- [Bun](https://bun.sh/)
- Rust stable (พร้อม Cargo)
- Go
- PostgreSQL (เฉพาะเมื่อรัน team server)

บน macOS ต้องมี Xcode Command Line Tools สำหรับ build Tauri

## เริ่มต้นพัฒนา

```bash
bun install
bun run dev:desktop   # เปิดแอปเดสก์ท็อป
bun run dev:server    # team server ที่ http://127.0.0.1:8787/health
bun run dev:web       # เว็บแดชบอร์ดที่ http://localhost:5173
```

ตรวจสอบโค้ดทั้งหมด:

```bash
bun run check
```

รัน test ทั้งหมด:

```bash
bun run test
```

ทดสอบเฉพาะ UI ของแอปเดสก์ท็อป:

```bash
cd apps/desktop
bun test src
bun run check
```

E2E (Playwright):

```bash
bun run test:e2e
```

## คำสั่งที่ใช้บ่อย

| คำสั่ง | ทำอะไร |
| --- | --- |
| `bun run dev:desktop` | เปิดแอปเดสก์ท็อป |
| `bun run build:desktop` | build แอปเดสก์ท็อป |
| `bun run verify:desktop` | ตรวจสอบ bundle ที่ build แล้ว |
| `bun run dev:web` | เปิดเว็บแดชบอร์ด |
| `bun run dev:server` | เปิด team server |
| `bun run check` | svelte-check, cargo check และ go vet |
| `bun run test` | test ของ desktop, agent-host, web, Rust และ Go |
| `bun run test:e2e` | ทดสอบ E2E ด้วย Playwright |

## ทีมเซิร์ฟเวอร์และเว็บแดชบอร์ด

Team server รับเฉพาะ metadata ของงาน ไม่รับโค้ดหรือข้อมูลลับ

1. เริ่ม PostgreSQL สำหรับพัฒนาและรัน server ด้วย `KINGU_DEV=1`
   (ดู [apps/server/README.md](apps/server/README.md#run-locally))
2. สร้าง token สำหรับพัฒนา:

   ```bash
   curl -s -X POST localhost:8787/v1/dev/tokens \
     -H 'Content-Type: application/json' \
     -d '{"org_name":"dev","user_id":"you"}'
   ```

   จะได้ผลลัพธ์เช่น `{"token":"kgu_…","org_id":…}`

3. เปิดเว็บแดชบอร์ดและเข้าสู่ระบบด้วย token:

   ```bash
   KINGU_API_URL=http://127.0.0.1:8787 bun run dev:web
   ```

4. ในแอปเดสก์ท็อป ตั้งค่า `kingu.team.serverUrl` เช่น `http://localhost:8787`
   และ `kingu.team.project` เป็น project id จาก `POST /v1/projects`
   จากนั้นรันคำสั่ง **Kingu: Sign in to Team Server**
   token จะถูกเก็บใน macOS Keychain

ดูรายละเอียดเพิ่มเติมที่ [apps/web/README.md](apps/web/README.md)

## เอกสารเพิ่มเติม

- [MECHANICS.md](MECHANICS.md) — กติกาที่อ่านจาก Orca และวิธีที่ Kingu นำมาใช้
- [docs/PLAN.md](docs/PLAN.md) — แผนพัฒนาและสถาปัตยกรรม
- [docs/ADE-PARITY.md](docs/ADE-PARITY.md) — สถานะความเหมือนของ ADE เทียบ Orca
- [docs/IDE-PARITY.md](docs/IDE-PARITY.md) — สถานะความเหมือนของ IDE เทียบ VS Code
- [docs/AI-SURFACES.md](docs/AI-SURFACES.md) — พื้นผิวที่ agent และ CLI ใช้ควบคุมแอป

## สัญญาอนุญาต

Copyright 2026 Anthovai

Licensed under the [Apache License, Version 2.0](LICENSE)
สัญญาอนุญาต: Apache License 2.0 ลิขสิทธิ์ © 2026 Anthovai

Third-party notices are listed in [NOTICE](NOTICE)
