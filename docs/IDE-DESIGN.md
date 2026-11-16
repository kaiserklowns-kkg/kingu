# Kingu IDE: การออกแบบ (อ้างอิง VS Code 1.142)

- **วันที่:** 2026-10-17
- **ที่มาของข้อมูล:**
  - **REA** วิเคราะห์ VS Code 1.142.0 ที่ติดตั้งอยู่ (`/Applications/Visual Studio Code.app`) แบบ static
  - **CSS และค่าคงที่ใน bundle ที่แจกจ่าย** เรียกในเอกสารนี้ว่า **(A)**
  - **source ของ Code-OSS** ใน `/Users/bright/kingu-old/src/vs` (MIT) เรียกในเอกสารนี้ว่า **(B)** ค่าที่สุ่มเทียบกับ (A) ตรงกันทั้งหมด
- **ข้อจำกัดของ REA:**
  - วิเคราะห์ `main.js` / `mainImpl.js` / `workbench.js` ได้ (Evidence `ev_da245e34…`): BrowserWindow 3 จุด, utility process 1 ตัว, IPC main handler 3 ตัวที่ชื่อ channel สร้างแบบ dynamic, การตรวจผู้ส่ง 8 จุด
  - `workbench.desktop.main.js` (20 MB) parser ของ REA อ่านไม่ผ่าน (`parse_failures: 1`, Evidence `ev_1ceca974…`) ข้อมูลส่วน UI จึงมาจาก (A) และ (B)

> **หลักการ:** ทำ **พฤติกรรมและการจัดวาง** ให้เหมือน VS Code ทั้งขนาด คีย์ลัด และ flow แต่ **ไม่ลอกโลโก้หรือไอคอน** ของ Microsoft และเขียนโค้ดใหม่ทั้งหมดด้วย Svelte + Rust

---

## 1. Layout

### 1.1 Parts (B: `layoutService.ts:21-32`)

| Part ของ VS Code | Kingu | สถานะ prototype |
|---|---|---|
| TITLEBAR (35px เมื่อมี command center) | `TitleBar.svelte` มี command center ตรงกลาง | ✅ |
| ACTIVITYBAR (กว้าง 48, ปุ่ม 48, ไอคอน 24) | `ActivityBar.svelte` | ✅ |
| SIDEBAR (เริ่มต้น 300, ต่ำสุด 170) | `SideBar.svelte`: Explorer / Search / Source Control / Agents | ✅ Explorer, Agents |
| EDITOR | `EditorPart.svelte` (แท็บ 35, breadcrumbs 22) | ✅ 1 group |
| PANEL (ซ่อนเป็นค่าเริ่มต้น, สูงต่ำสุด 77) | `Panel.svelte`: Problems / Output / Terminal | ✅ |
| AUXILIARYBAR (ซ่อนเป็นค่าเริ่มต้น, เริ่มต้น 300) | `AuxiliaryBar.svelte` ใช้วาง **Agent** (ส่วน ADE) | ✅ |
| STATUSBAR (สูง 22) | `StatusBar.svelte` | ✅ |
| BANNER | — | P2 |

### 1.2 Grid (B: `layout.ts:2595-2801`)

```
VERTICAL [ titlebar | MIDDLE | statusbar ]
MIDDLE (panel ด้านล่าง, alignment=center):
  HORIZONTAL [ activitybar | sidebar | VERTICAL[ editor | panel ] | auxiliarybar ]
```

- **Sash:** หนา 4px (`--vscode-sash-size`) รอ hover 300ms
- **State ที่ต้องจำ:** ขนาดและการซ่อนของแต่ละ part, ตำแหน่ง sidebar และ panel
  - ระดับ workspace: การซ่อน part
  - ระดับ profile: ขนาด part
  - Prototype ใช้ `localStorage` ไปก่อน แล้วค่อยย้ายไป Rust state

### 1.3 ขนาดคงที่ (A/B)

| ส่วน | ค่า |
|---|---|
| Title bar | 35 |
| Activity bar | 48 × ปุ่ม 48, ไอคอน 24 |
| Part title / panel title | 35 |
| Pane header | 22 |
| แถวของ list / tree | 22 |
| Editor tab | 35 |
| Breadcrumbs | 22 |
| Status bar | 22 (`line-height:22px`) |
| Quick input | กว้าง 600 (หรือ 0.62 × ความกว้างหน้าต่าง) |
| Toast พร้อมกัน | สูงสุด 3 |

## 2. ระบบคำสั่ง คีย์ลัด และ context

**VS Code (B: `actions.ts:724-790`):** `registerAction2({id, title, f1, keybinding, menu, precondition})` ทำ 4 อย่าง
1. ลงทะเบียน command
2. ใส่ใน menu
3. ใส่ใน Command Palette ถ้า `f1`
4. ลงทะเบียน keybinding พร้อม `when`

ใน `workbench/` มีราว **1,515** จุด

**Kingu:** `commands.svelte.ts` ใช้รูปแบบเดียวกันแบบย่อ
```ts
registerCommand({ id, title, category?, keybinding?: { mac, other }, when?: () => boolean, run })
```
- รายการใน palette (`>`) มาจาก registry นี้
- ตัวจับคีย์ใช้ listener ระดับหน้าต่างตัวเดียว
- ลำดับความสำคัญ (`weight`) จะเพิ่มเมื่อมี plugin

**คีย์ลัดเริ่มต้นบน macOS (B)** prototype ทำครบทุกตัว

| Command id | คีย์ |
|---|---|
| `workbench.action.quickOpen` | ⌘P |
| `workbench.action.showCommands` | ⇧⌘P |
| `workbench.action.toggleSidebarVisibility` | ⌘B |
| `workbench.action.toggleAuxiliaryBar` | ⌥⌘B |
| `workbench.action.togglePanel` | ⌘J |
| `workbench.action.terminal.toggleTerminal` | ⌃` |
| `workbench.action.files.save` | ⌘S |
| `workbench.action.closeActiveEditor` | ⌘W |
| `workbench.action.findInFiles` | ⇧⌘F (P1: ตอนนี้แค่เปิด view) |
| `workbench.action.splitEditor` | ⌘\ (P1) |

**Quick access prefix (B):**
- `>` คำสั่ง
- ว่าง = ไฟล์
- `@` symbol ในไฟล์ (P1)
- `:` ไปบรรทัด
- `#` symbol ใน workspace (P1)

## 3. Editor group

**VS Code (B: `editorGroupModel.ts`):**
- แต่ละ group มี **preview editor** ได้ 1 ตัว แสดงชื่อแท็บเป็นตัวเอียง
- เปิดไฟล์ใหม่แบบยังไม่ pin จะแทนที่ preview ตัวเดิม
- ดับเบิลคลิกหรือแก้ไฟล์จะ pin แท็บ
- sticky tab อยู่ด้านหน้าเสมอ

**Kingu:** `editors.svelte.ts` (P0)
- รองรับ open / preview / pin / close / active
- มีสถานะ dirty แสดงเป็นจุด ● แทนปุ่ม ×
- ⌘S บันทึกผ่าน Rust `fs_write_file`
- Monaco ใช้ model 1 ตัวต่อไฟล์ จึงจำตำแหน่ง cursor และ undo ไว้ได้

**ยังไม่ทำ:** split group (P1), auto save (ค่าเริ่มต้นของ VS Code บน desktop คือ `off`) และ hot exit / backup (P1)

## 4. Services: VS Code → Kingu

| VS Code service (B) | Kingu (Rust command / Svelte store) | Tier |
|---|---|---|
| ICommandService, IKeybindingService, IContextKeyService | `commands.svelte.ts` | P0 |
| IWorkbenchLayoutService | `layout.svelte.ts` | P0 |
| IEditorService / IEditorGroupsService | `editors.svelte.ts` | P0 (1 group) |
| IFileService | Rust: `fs_list_dir`, `read_workspace_file`, `fs_write_file`, `fs_list_files` (ตรวจ path ให้อยู่ใน workspace เสมอ) | P0 |
| IQuickInputService | `QuickInput.svelte` + fuzzy matcher | P0 |
| ITerminalService / pty host | Rust `pty.rs` + xterm.js | P0 (มีแล้ว) |
| IThemeService + color registry | CSS variables `--vscode-*` จากธีม Dark Modern | P0 (ชุดย่อย) |
| IStatusbarService | `StatusBar.svelte` (ช่องซ้าย/ขวา) | P0 |
| INotificationService | toast (สูงสุด 3 ตามแบบ VS Code) | P1 |
| ISearchService (ripgrep) | Rust เรียก `rg` ที่ bundle มากับแอป | P1 |
| ISCMService | Rust ใช้ `git` CLI | P1 |
| IMarkerService / ILanguageFeaturesService | LSP client ↔ language server | P1 |
| IConfigurationService (scopes) | `settings.json` ระดับ user และ workspace | P1 |
| IExtensionService | plugin API ของ Kingu (ไม่รัน VS Code extension) | P2 |
| Agent host (`agentHostMain.js`) | Rust `agent/` (มีแล้ว) แสดงใน Auxiliary Bar | P0 |

## 5. Process model

| VS Code (B) | Kingu |
|---|---|
| main (Electron) | Tauri core (Rust) |
| renderer (workbench) | WebView + Svelte |
| shared process, file watcher, search | thread หรือ task ใน Rust (`notify`, `rg`) |
| pty host | `pty.rs` (thread ต่อ session) |
| extension host (Node) | ไม่มี ใช้ LSP/DAP แทน (P2: plugin host ผ่าน Bun) |
| agent host | `agent/runner.rs` |

## 6. Theme

- **VS Code (B):**
  - ลงทะเบียนสีด้วย `registerColor` ราว 979 จุด
  - ชื่อสีแปลงเป็น CSS variable เช่น `editor.background` → `--vscode-editor-background`
  - CSS ของ workbench อ้าง `--vscode-*` 749 ตัว (A)
- **Kingu (P0):** สร้าง CSS variable ชุดย่อยที่ chrome ใช้จริง เช่น titleBar, activityBar, sideBar, tab, editor, panel, statusBar, list, input, focusBorder
  - ใช้ชื่อเดียวกับ VS Code ทุกตัว เพื่อให้นำธีม JSON ของ VS Code มาใช้ตรงๆ ได้ภายหลัง
  - ค่าสีมาจาก `dark_modern.json` ที่ vendor ไว้แล้วใน `src/lib/editor/textmate/themes/`

## 7. นอกขอบเขตของ prototype นี้

- Multi-root workspace, remote / SSH และ profile
- Debugger (DAP), Testing view และ Notebook
- Settings UI (ตอนนี้ใช้ JSON)
- ตัวเลือกเปิดโฟลเดอร์อื่น (ตอนนี้ใช้ `KINGU_WORKSPACE` หรือ repo นี้)
