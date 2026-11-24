# ตรวจแอป Orca, VS Code และ Cursor — 2026-11-24

> อัปเดตล่าสุด: 2026-11-24 08:09 +07 — ตรวจ artifact และ API ซ้ำแล้ว

## สรุป

ทั้งสามแอปติดตั้งอยู่บนเครื่องนี้และผ่านการตรวจแบบ static จาก artifact จริงใน `/Applications` ไม่ได้เปิดแอป ไม่ได้ต่อ debugger และไม่ได้รัน runtime

สถานะที่สำคัญ ณ 2026-11-24:

- **Orca** ติดตั้ง 1.4.272 และ stable ล่าสุดคือ 1.4.272 — ตรงกัน (อัปเดตจาก 1.4.269 ระหว่างช่วงตรวจ)
- **VS Code** ติดตั้ง 1.143.1 แต่ stable ล่าสุดคือ 1.147.0 — ตามหลัง 4 รุ่น
- **Cursor** ติดตั้ง 3.27.22 แต่ตัวดาวน์โหลด stable ล่าสุดคือ 3.31.15 — ตามหลัง 4 minor

ทิศทางร่วมของทั้งสามแอปชัดเจนขึ้นในรอบนี้: **agent host แยกจาก UI, หลาย harness ใน session เดียว, permission/sandbox ที่ละเอียดขึ้น, worktree/remote environment เป็นหน่วยของงาน และ browser/computer use เป็นส่วนหนึ่งของ agent loop**

## วิธีตรวจและขอบเขต

ตรวจจาก:

- `/Applications/*.app/Contents/Info.plist`
- `/Applications/*.app/Contents/Resources/app/product.json`
- `/Applications/*.app/Contents/Resources/app.asar` (Orca)
- `/Applications/Orca.app/Contents/Resources/app.asar` ที่ extract แล้ว
- release notes ทางการของ Orca, VS Code และ Cursor download API
- deep REA reports ที่มีอยู่แล้ว:
  - [`REA-essence-vscode-orca-cursor.md`](./REA-essence-vscode-orca-cursor.md)
  - [`REA-analysis-vscode-orca-dbeaver.md`](./REA-analysis-vscode-orca-dbeaver.md)

ข้อจำกัด:

- เป็น static inspection ไม่ใช่ full REA semantic analysis
- ไม่ได้ทดสอบพฤติกรรมจริงของ agent, browser, terminal หรือ permission flow
- Cursor ไม่มี changelog API ที่อ่าน version delta ได้ตรง ๆ จาก artifact เครื่องนี้
- ตัวเลข/ขนาดเป็นของ artifact ที่ติดตั้ง ไม่ใช่ทั้งโปรเจกต์

## สถานะเวอร์ชันที่ติดตั้ง

| รายการ | Orca | VS Code | Cursor |
| --- | --- | --- | --- |
| ติดตั้ง | **1.4.272** | **1.143.1** | **3.27.22** |
| Stable ล่าสุด | **1.4.272** | **1.147.0** | **3.31.15** |
| สถานะ | ตรงกับ stable | ตามหลัง 4 รุ่น | ตามหลัง 4 minor |
| Bundle ID | `com.stablyai.orca` | `com.microsoft.VSCode` | `com.todesktop.230313mzl4w4u92` |
| Build/commit | 1.4.272 | `e646868227c3e3a9e3f24277c8c7220be42c0be7` | `b1aa50cb6db84fd3e8c808259cb172ea73425c10` |
| Build date | 2026-11-23 | 2026-10-22 | 2026-10-27 |
| Electron | 43.8.10 | 43.7.7 | 42.11.16 |
| สถาปัตยกรรม | arm64 | arm64 | arm64 |
| ขนาด .app | 773 MB | 885 MB | 1.0 GB |
| Code signing | Notarized Developer ID | Notarized Developer ID | Notarized Developer ID |
| Team ID | `6CX3WHS9HZ` | `UBF8T346G9` | `VDXQ22DGB9` |

## ภาพรวมสถาปัตยกรรม

### Orca 1.4.272

- Electron + React + TypeScript
- entry point: `out/main/index.js` ขนาดประมาณ 7.5 MB
- `out/` มี 6,756 ไฟล์; main ประมาณ 24 MB, renderer ประมาณ 88 MB, shared ประมาณ 21 MB, CLI ประมาณ 3.4 MB
- runtime dependencies 28 ตัว รวม `@anthropic-ai/claude-agent-sdk` 0.3.319, `@orca/process-host`, `node-pty`, `ssh2`, `ws`, `agent-browser` 0.43.0
- แยก PTY/process ออกจาก main ผ่าน `out/main/orcad`, `out/main/daemon`, `out/packages/process-host`
- มี worker entry จำนวนมาก เช่น `journal-sql-worker-entry`, `session-search-worker-entry`, `workspace-space-scan-worker-entry`, `bots-db-worker-entry`

ข้อสังเกต: Orca ยังเป็นแอปที่ IPC/command surface กว้างมาก และ preload ยังรวม API เป็นก้อนเดียวตามรายงาน REA เดิม

### VS Code 1.143.1

- Electron + workbench เดิมของ Microsoft
- built-in extensions 97 ตัว
- มี `out/vs/platform/agentHost/node/agentHostMain.js` แยกเป็น utility process
- workbench หลักยังเป็น service/contribution architecture
- Electron 43.7.7

ข้อสังเกต: แม้เวอร์ชันติดตั้งจะเก่า แต่โครงสร้าง Agent Host มีอยู่แล้ว และรุ่นใหม่กว่าเพิ่ม Agent Host Protocol, remote agent host และ multi-harness เข้ามาชัดเจน

### Cursor 3.27.22

- VS Code fork โดยใช้ base `1.128.0`
- Electron 42.11.16
- มี `extensions/cursor-agent-host`, `extensions/cursor-agent-worker`, `extensions/cursor-agent-exec`
- มี `molten/dist/pty-host/pty-host.cjs`
- สถาปัตยกรรมยังเป็น “Molten Glass”: host / engine / pty-host แยกกัน

ข้อสังเกต: Cursor ใช้ Electron เก่ากว่าอีกสองตัว และ base VS Code เก่ากว่า VS Code ที่ติดตั้งอยู่หลายรุ่น

## Delta ที่สำคัญ

### Orca 1.4.259 → 1.4.272

จาก release notes และ inventory ของ `app.asar`:

- **1.4.272 (ล่าสุด)** — bot ฟื้นงานหลัง interruption ได้ดีขึ้น, resume chat/worker หลัง crash หรือ restart, browser tools/extensions ใช้ข้าม SSH และ paired server, `/btw` หรือ `/side` side chat, Memory Saver unload hidden device tabs, WSL idle stop, mobile group photos/Needs you/delete chats
- **1.4.271** — bot group ข้าม paired computers, bot รัน Qwen Code, phone จัดการ agent ได้ครบขึ้น, ลบ chat/ทำงานต่อหลัง usage limit, WSL/Windows เสถียรขึ้น, หลาย GitHub account
- **1.4.269** — Bots รันได้บน Kiro, Kimi Code, Auggie, Gemini CLI, Kilo Code, MiMo Code, Droid และ Goose; Chat เปิด Kiro/Auggie/Goose ได้; phone ตอบคำถาม อนุมัติ tool/access request และตั้งค่า agent ได้มากขึ้น; Mac ใช้ CPU น้อยลงเมื่อ idle; Git งานหนักย้ายไป process worker
- **Orca Bots (Beta)** — bot เป็น first-class teammate, managed agent session มี identity/tools ของตัวเอง, แชร์ผ่าน CLI ได้, เชื่อม Slack/Gmail
- **Fleet orchestration และ approvals** — มี `out/shared/orchestration/fleet`, `out/shared/orchestration/approvals`, `out/shared/rpc-contract/orchestration`
- **Agent expansion** — Cursor เข้า Chat (1.4.261), Hermes เข้า Chat (1.4.263), Antigravity sign-in ด้วย Gemini API key/ADC, ติดตั้ง OpenCode/Cursor/Copilot/Grok/Kimi Code/OMP ให้เองเมื่อ host ไม่มี
- **Memory Saver / browser** — คืน memory ของ browser tab ที่ไม่ถูกใช้, คง session cookie ข้าม restart, browser extension side panel
- **Workspace Cleanup** — ลบ chat ของ workspace ที่ถูกลบแล้ว (ปิดไว้โดย default)
- **Performance** — โหลด chat history เป็นหน้า, ลดงานของ hidden views, session save ที่ไม่เขียนซ้ำ
- **Mobile 0.0.68** — unread bells, agent history filter, quote passage, choose Chat/CLI บน phone

โมดูลใหม่ที่เห็นใน artifact:

- `out/shared/bots/*`
- `out/shared/orchestration/fleet/*`
- `out/shared/orchestration/approvals/*`
- `out/shared/rpc-contract/bots-*.js`
- `out/shared/workspace-cleanup/*`
- `out/shared/palette-match/*`
- `out/shared/file-import/*`
- `out/main/journal-sql-worker-entry.js`
- `out/main/session-search-worker-entry.js`
- `out/main/bots-db-worker-entry.js`

### VS Code 1.143.1 → 1.147.0

สรุปจาก release notes ทางการ:

- **1.144** — Agent Host Protocol v1.0, Copilot tasks ใน cloud, remote environments, computer use, canvases, assisted permissions GA, worktree storage (experimental)
- **1.145** — remote agent host, remote canvases, mix-and-match agent harnesses ใน session เดียว, cron schedules, MCP app tools, managed MCP allowlist
- **1.146** — Copilot harness, inbox mode, chat windows, extensions ใน Agents window, Skills over MCP, permission prompts ที่ดีขึ้น, mask environment variables ใน sandbox
- **1.147** — Send Later, save/resume drafts, share remote environments, model routers, browser use, screenshot/attach images, retry with updated sandbox permissions

ทิศทาง: VS Code กำลังรวม agent session, remote environment, หลาย harness, browser/computer use และ permission/sandbox ไว้ใน workbench เดียว — ใกล้กับสิ่งที่ Orca และ Cursor ทำ

### Cursor 3.27.22 → 3.31.15

- เครื่องนี้ติดตั้ง 3.27.22; ตัวดาวน์โหลด stable ทางการตอบ 3.31.15
- ยังไม่ได้ยืนยัน delta รายฟีเจอร์ เพราะ changelog page ไม่เปิดเผยเลขเวอร์ชันใน HTML แบบที่อ่านได้ตรง ๆ และไม่มี artifact 3.31.15 บนเครื่อง
- สิ่งที่ยืนยันได้จาก artifact 3.27.22: ยังใช้ `cursor-agent-host`, `cursor-agent-worker`, `cursor-agent-exec` และ `molten/dist/pty-host`
- ข้อสรุปที่ปลอดภัย: สถาปัตยกรรมหลักยังเป็น VS Code fork + Molten แยก host/engine/pty; รายละเอียดฟีเจอร์ใหม่ต้องตรวจจากเครื่องที่อัปเดตแล้วหรือ release notes โดยตรง

## Security และ package snapshot

| รายการ | Orca | VS Code | Cursor |
| --- | --- | --- | --- |
| Notarized | ใช่ | ใช่ | ใช่ |
| Hardened Runtime | เปิด | เปิด | เปิด |
| JIT entitlement | เปิด | เปิด | เปิด |
| Camera/Microphone | เปิด | เปิด | เปิด |
| Apple Events | เปิด | เปิด | เปิด |
| Bluetooth | เปิด | ไม่พบ | ไม่พบ |
| USB | เปิด | ไม่พบ | ไม่พบ |
| Contacts/Calendars/Location | เปิด | ไม่พบ | ไม่พบ |
| Unsigned executable memory | เปิด | ไม่พบ | ไม่พบ |

ข้อสังเกต: Orca ขอ entitlement กว้างกว่าอีกสองตัวชัดเจน โดยเฉพาะ USB, Bluetooth, Contacts, Calendars และ Location ซึ่งสอดคล้องกับรายงาน REA เดิมเรื่อง surface ของ macOS permission

ไม่ได้ตรวจ CVE หรือช่องโหว่ของแต่ละเวอร์ชันในรอบนี้

## สิ่งที่ Kingu ควรนำไปใช้

1. **Agent host + protocol เป็นมาตรฐานแล้ว** — ทั้ง VS Code และ Cursor แยก agent runtime ออกจาก UI; Kingu มาถูกทางที่มี sidecar/agent host
2. **Worktree + session + permission เป็นแกนเดียว** — Orca และ VS Code กำลังรวม worktree, remote environment, session, approval ไว้ในโมเดลเดียว
3. **หลาย harness ต่อ session กำลังเป็นของปกติ** — VS Code 1.145 ทำ mix-and-match harness; Orca ติดตั้ง agent หลายค่ายเอง; Kingu ควรออกแบบ session model ให้ไม่ผูกกับ CLI ตัวเดียว
4. **Permission/sandbox ต้องละเอียดกว่า allow/deny** — ทั้งสามแอปเพิ่ม assisted permission, sandbox retry, env masking, approval routing
5. **Browser/computer use ไม่ใช่ของแถม** — กลายเป็นส่วนหนึ่งของ agent loop; Kingu มี browser surface แล้ว แต่ควรวาง permission boundary ให้ชัด
6. **อย่าลอก Bots/Slack/Gmail ตอนนี้** — เป็น enterprise/connector scope ที่ใหญ่และไม่ใช่แกนของ Kingu
7. **จุดที่ Kingu ยังได้เปรียบ** — Tauri + Rust เบากว่า, local-first, surface เล็กกว่า, ไม่มี legacy workbench 40 MB

## ข้อเสนอ

1. Orca อยู่ที่ 1.4.272 แล้ว; อัปเดต VS Code เป็น 1.147.0 และ Cursor เป็น 3.31.15 ถ้าต้องการเทียบฟีเจอร์ล่าสุด
2. ถ้าจะทำ parity รอบถัดไป ให้ดู 3 เรื่องก่อน: multi-harness session, permission/sandbox model และ remote environment
3. เก็บ `docs/REA-essence-vscode-orca-cursor.md` เป็น baseline ลึก และใช้รายงานนี้เป็น snapshot ของเวอร์ชัน ณ 2026-11-24
4. ถ้าต้องการ Cursor delta จริง ให้ติดตั้ง 3.31.15 แล้วรัน REA/extract artifact เทียบกับ 3.27.22

## Evidence

- Orca: `/Applications/Orca.app/Contents/Resources/app.asar`, `package.json` ระบุ `version: 1.4.272`; GitHub releases ล่าสุด `v1.4.272` (2026-11-23T12:35Z)
- VS Code: `/Applications/Visual Studio Code.app/Contents/Resources/app/product.json` ระบุ `1.143.1`, commit `e6468682...`; stable update API ระบุ `1.147.0`
- Cursor: `/Applications/Cursor.app/Contents/Resources/app/product.json` ระบุ `3.27.22`, commit `b1aa50cb...`; download API ระบุ `3.31.15`
- Electron: อ่านจาก `Contents/Frameworks/Electron Framework.framework/Resources/Info.plist`
- Code signing/entitlements: `codesign -dv` และ `codesign -d --entitlements :-`
- Existing deep analysis: [`REA-essence-vscode-orca-cursor.md`](./REA-essence-vscode-orca-cursor.md)
