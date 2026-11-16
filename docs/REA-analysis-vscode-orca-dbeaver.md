# รายงานวิเคราะห์ VS Code, Orca และ DBeaver ด้วย REA

- **วันที่วิเคราะห์:** 2026-10-16
- **เครื่องที่ใช้:** macOS (Darwin 25.5.0), Apple Silicon (arm64)
- **เครื่องมือ:** REA (Reverse Engineering Agents) ผ่าน MCP ร่วมกับเครื่องมือมาตรฐานของ macOS (`codesign`, `unzip`, `@electron/asar`)
- **ขอบเขต:** วิเคราะห์แบบ static จากไฟล์ที่ติดตั้งอยู่ใน `/Applications` อย่างเดียว ไม่ได้รันหรือแก้ไขแอป

> **วิธีอ่านรายงานนี้**
> - **สังเกตได้ (observed):** ข้อมูลที่อ่านได้ตรงจากไฟล์ เช่น entitlements, fuses และรายชื่อไฟล์
> - **อนุมาน (inferred):** ข้อสรุปที่ได้จากการตีความข้อมูลข้างต้น ในรายงานจะระบุคำว่า "อนุมาน" ไว้ทุกครั้ง
> - **ยังไม่ทราบ (unknown):** ส่วนที่ยังไม่ได้ตรวจ หรือผลวิเคราะห์ไม่ครบ ห้ามตีความว่า "ไม่มี"

---

## สารบัญ

1. [สรุปสำหรับผู้บริหาร](#1-สรุปสำหรับผู้บริหาร)
2. [ข้อมูลพื้นฐานของแต่ละแอป](#2-ข้อมูลพื้นฐานของแต่ละแอป)
3. [VS Code](#3-visual-studio-code)
4. [Orca](#4-orca-stablyai)
5. [DBeaver](#5-dbeaver-community-edition)
6. [เปรียบเทียบด้านความปลอดภัยของแพ็กเกจ](#6-เปรียบเทียบด้านความปลอดภัยของแพ็กเกจ)
7. [เปรียบเทียบด้าน UX/UI](#7-เปรียบเทียบด้าน-uxui)
8. [ข้อเสนอแนะ](#8-ข้อเสนอแนะ)
9. [ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ](#9-ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ)
10. [ภาคผนวก: Evidence IDs และวิธีทำซ้ำ](#10-ภาคผนวก-evidence-ids-และวิธีทำซ้ำ)

---

## 1. สรุปสำหรับผู้บริหาร

| หัวข้อ | VS Code | Orca | DBeaver |
|---|---|---|---|
| ประเภทแอป | Code editor / IDE | ตัวจัดการ AI coding agent | เครื่องมือจัดการฐานข้อมูล |
| เทคโนโลยี | Electron 43.7.7 | Electron 43.7.5 + React | Java 25 + Eclipse RCP/SWT |
| ความเสี่ยงจากการตั้งค่าแพ็กเกจ | ปานกลาง | ปานกลางค่อนข้างสูง | **สูงที่สุดในสามตัว** |
| จุดที่ควรระวังที่สุด | Electron fuses ตั้งค่าหลวม | ขอสิทธิ์ macOS มาก, ฝัง source ฝั่ง cloud มาในแอป | ปิด library validation |
| ความทันสมัยของ UI | ปานกลาง | สูง | ต่ำ (หน้าตาแบบ Eclipse) |
| Accessibility | ดีที่สุด | ปานกลาง | อาศัยความสามารถของ widget macOS |
| ภาษาไทย | มี (ติดตั้ง Language Pack เพิ่ม) | ไม่มี | ไม่มี |

**ข้อค้นพบหลัก**

1. **DBeaver** ปิดการตรวจว่า library ที่โหลดต้องเซ็นโดยผู้ที่เชื่อถือได้ (`disable-library-validation`) และยังรับตัวแปร `DYLD_*` ด้วย ผลคือแทรก dylib ที่ไม่ได้เซ็นเข้าไปในโปรเซสได้ (อนุมาน) DBeaver เก็บรหัสผ่านฐานข้อมูลไว้ จึงเป็นเป้าหมายที่มีมูลค่าสูง
2. **Orca** ฝัง source code ฝั่ง backend มาในแอป ได้แก่ โฟลเดอร์ `cloud/` 662 ไฟล์ ซึ่งมี Terraform, Dockerfile, เอกสาร ops ภายใน และไฟล์ test 220 ไฟล์ นอกจากนี้ยังขอสิทธิ์ macOS กว้างที่สุดในสามตัว
3. **VS Code และ Orca** ตั้งค่า Electron fuses เหมือนกันทุกข้อ คือเปิด `RunAsNode`, เปิด `NODE_OPTIONS` และ `--inspect`, ไม่ตรวจความถูกต้องของ ASAR และไม่บังคับโหลดโค้ดจาก `app.asar` เท่านั้น
4. **UX:**
   - Orca มี design system ทันสมัยที่สุด และพาผู้ใช้ใหม่เริ่มใช้งานได้ดีที่สุด
   - VS Code ทำ accessibility ได้ดีที่สุด
   - DBeaver มีฟังก์ชันมากที่สุด แต่ตัวเลือกเยอะจนหาได้ยาก

---

## 2. ข้อมูลพื้นฐานของแต่ละแอป

| รายการ | VS Code | Orca | DBeaver |
|---|---|---|---|
| Path | `/Applications/Visual Studio Code.app` | `/Applications/Orca.app` | `/Applications/DBeaver.app` |
| Bundle ID | `com.microsoft.VSCode` | `com.stablyai.orca` | `org.jkiss.dbeaver.core.product` |
| เวอร์ชัน | 1.141.1 | 1.4.226 | 26.2.2 |
| Executable | `Code` | `Orca` | `dbeaver` |
| ขนาดบนดิสก์ | 902 MB | 770 MB | 195 MB |
| สถาปัตยกรรม | arm64 (thin) | arm64 (thin) | arm64 (thin) |
| ผู้เซ็นแอป | Microsoft Corporation | Lovecast LLC | DBeaver Corporation |
| Team ID | UBF8T346G9 | 6CX3WHS9HZ | 42B6MDKMW8 |
| วันที่เซ็น | 13 ต.ค. 2569 | 15 ต.ค. 2569 | 5 ต.ค. 2569 |
| Hardened Runtime | เปิด | เปิด | เปิด |
| Notarization chain | Developer ID → Apple Root CA | Developer ID → Apple Root CA | Developer ID → Apple Root CA |

---

## 3. Visual Studio Code

### 3.1 สถาปัตยกรรม

- **Runtime:** Electron Framework 43.7.7 (`CFBundleVersion` ใน Electron Framework.framework)
- **Entry point:** `Contents/Resources/app/out/main.js` (ตามที่ระบุใน `package.json`)
- **Build:** commit `7baac39ec3ca969dab74ac12c097f6a486e46593` เมื่อ 2026-10-12T12:00:06-07:00 (จาก `product.json` ซึ่งมี 129 key)
- **โครงสร้างหลักใน `Contents/Resources/app/`:**

| ส่วน | ขนาด / จำนวน | หน้าที่ |
|---|---|---|
| `out/` | 70 MB | โค้ดหลักของ workbench ที่ bundle แล้ว เช่น `vs/workbench/workbench.desktop.main.js` |
| `node_modules.asar` | 55 MB | dependency ของ Node.js |
| `extensions/` | 250 MB, 97 ตัว | extension ที่ติดมากับแอป เช่น ภาษา ธีม และ Git |
| `product.json` | — | ค่าตั้งต้นของผลิตภัณฑ์ เช่น marketplace และ telemetry |
| `telemetry-core.json`, `telemetry-extensions.json` | — | รายการ event สำหรับ telemetry |
| `policies/` | — | Group policy สำหรับองค์กร |

- **Helper process:** `Code Helper`, `Code Helper (GPU)`, `Code Helper (Renderer)` และ `Code Helper (Plugin)`
- **Framework อื่น:** Squirrel (auto-update), Mantle และ ReactiveObjC

### 3.2 Code Signature และ Entitlements

Evidence: `ev_7fed1194b383c4b7e57662f5b9d743acc9140c3b80c47caec81eaec1e1f23f48`

| Entitlement | ค่า | ความหมาย |
|---|---|---|
| `com.apple.security.cs.allow-jit` | true | จำเป็นสำหรับ V8 JavaScript engine |
| `com.apple.security.device.camera` | true | ใช้กล้องได้ (สำหรับ WebRTC และ extension) |
| `com.apple.security.device.audio-input` | true | ใช้ไมโครโฟนได้ เช่น Voice Chat |
| `com.apple.security.automation.apple-events` | true | สั่งงานแอปอื่นผ่าน AppleScript ได้ |

**ประเมิน:** ขอสิทธิ์น้อยที่สุดในสามแอป ไม่มี `allow-unsigned-executable-memory`, ไม่มี `allow-dyld-environment-variables` และไม่มี `disable-library-validation`

### 3.3 Electron Fuses

Evidence: `ev_1f70b1115e0cdd9e0e329020aa1b00828ae38ceef6c0cca9f52691b5e1b6eaf2` (sentinel อยู่ที่ offset 151617192)

| # | Fuse | สถานะ | ผลที่ตามมา |
|---|---|---|---|
| 0 | RunAsNode | เปิด | `ELECTRON_RUN_AS_NODE=1` ทำให้ตัวแอปทำงานเป็น Node.js ทั่วไป |
| 1 | EnableCookieEncryption | ปิด | ไม่เข้ารหัส cookie ที่เก็บบนดิสก์ |
| 2 | EnableNodeOptionsEnvironmentVariable | เปิด | รับ `NODE_OPTIONS` เช่น `--require` |
| 3 | EnableNodeCliInspectArguments | เปิด | รับ `--inspect` ทำให้ debugger ต่อเข้า main process ได้ |
| 4 | EnableEmbeddedAsarIntegrityValidation | ปิด | ไม่ตรวจ hash ของ ASAR ตอนโหลด |
| 5 | OnlyLoadAppFromAsar | ปิด | โหลดโค้ดจากโฟลเดอร์ `app/` ได้ |
| 6 | LoadBrowserProcessSpecificV8Snapshot | ปิด | — |
| 7 | GrantFileProtocolExtraPrivileges | เปิด | `file://` ได้สิทธิ์พิเศษ |
| 8 | WasmTrapHandlers | เปิด | — |

**ตีความ (อนุมาน):** VS Code น่าจะจำเป็นต้องเปิด `RunAsNode` เพราะ extension host, CLI (`code` command) และ language server ใช้ตัว Electron binary เป็น Node runtime อย่างไรก็ตาม ค่าแบบนี้ทำให้ VS Code ถูกใช้เป็น "living-off-the-land binary" ได้ คือผู้โจมตีที่รันคำสั่งในเครื่องได้แล้วจะรัน JavaScript ภายใต้ identity และสิทธิ์ TCC ของ VS Code ได้ เช่น สิทธิ์กล้องและไมโครโฟนที่ผู้ใช้เคยอนุญาตไว้

### 3.4 UX/UI

**เทคโนโลยี UI:** workbench ที่ Microsoft เขียนเอง ทำงานบน DOM ไม่ได้ใช้ React ใช้ฟอนต์ระบบ และใช้ไอคอนจากฟอนต์ Codicon (`out/media/codicon.ttf`)

**ธีม:** มีมาในแอป 19 color theme จาก 12 extension ดังนี้

| กลุ่ม | ธีม |
|---|---|
| ค่าเริ่มต้น | Dark Modern, Light Modern, Dark+, Light+, Dark, Light |
| ธีมใหม่ | **Dark 2026, Light 2026** |
| High Contrast | HC Dark (`hc-black`), HC Light (`hc-light`) |
| ธีมคลาสสิก | Abyss, Kimbie Dark, Monokai, Monokai Dimmed, Quiet Light, Red, Solarized Dark/Light, Tomorrow Night Blue |
| Icon theme | Seti (`vs-seti`), Minimal (`vs-minimal`), Modern Icons (`vscode-modern-icons`) |

**Accessibility:** จำนวน setting key ที่นับได้จาก `workbench.desktop.main.js`

| กลุ่ม setting | จำนวน key | หน้าที่ |
|---|---|---|
| `accessibility.signals.*` | 41 | เสียงหรือข้อความแจ้งเหตุการณ์ เช่น error, breakpoint และ AI แก้โค้ดเสร็จ |
| `accessibility.verbosity.*` | 37 | ระดับรายละเอียดที่ screen reader อ่าน |
| ไฟล์เสียง `.mp3` | 44 | เช่น `editsKept.mp3`, `editsUndone.mp3`, `nextEditSuggestion.mp3`, `voiceRecordingStopped.mp3` |

**Layout และตัวช่วยลดความรก:**
- Activity Bar, Primary Side Bar และ **Secondary Side Bar** (`defaultVisibility`, `forceMaximized`, `showLabels`)
- Panel, Status Bar และ Command Center (`window.commandCenter`)
- ปุ่มเลือก layout (`workbench.layoutControl.*`)
- Zen Mode (`zenMode.*` 11 key) และ Sticky Scroll (`editor.stickyScroll.*`)

**UI ที่หันมาเน้น AI:**
- มี setting `chat.*` ราว **401 key** (นับจาก pattern `chat.<x>.<y>`) ถือเป็นกลุ่ม setting ที่ใหญ่ที่สุดกลุ่มหนึ่ง
- ใช้ Secondary Side Bar เป็นพื้นที่หลักของ Chat และ Agent และสั่งขยายเต็มจอได้
- มีเสียงเฉพาะสำหรับเหตุการณ์ของ AI เช่น กดรับหรือยกเลิกการแก้ไข และคำแนะนำ next edit

**ภาษา:** ภาษาไทยต้องติดตั้ง Language Pack จาก Marketplace เพิ่ม

**จุดแข็ง:**
- Accessibility ละเอียดที่สุดในสามตัว
- มี High Contrast ทั้งแบบมืดและสว่าง
- ใช้ด้วยคีย์บอร์ดล้วนได้ผ่าน Command Palette
- ปรับแต่งได้สูงมาก

**จุดอ่อน:**
- ตัวเลือกเยอะมาก ผู้ใช้ใหม่หาสิ่งที่ต้องการได้ยาก
- ฟีเจอร์ AI เพิ่มความซับซ้อนให้ UI และหน้า Settings อย่างต่อเนื่อง

---

## 4. Orca (stablyai)

### 4.1 สถาปัตยกรรม

- **ผู้พัฒนา:** Stably AI ในนาม Lovecast LLC
- **Runtime:** Electron Framework 43.7.5
- **Build:** `1.4.226-d3fc80292be694f454717e18f82fdc19dbe353de-arm64` (`orca-local-build.json`)
  - **commit ไม่ตรงกัน:** `app.asar.unpacked/out/package.json` ระบุ `be7a3983…` แต่ `orca-local-build.json` ระบุ `d3fc8029…` อาจเป็นเพราะ build สองขั้น (อนุมาน)
- **Daemon protocol:** เวอร์ชัน 45 และต่อกับ daemon เวอร์ชัน 1 ถึง 45 ได้ทั้งหมด
- **Auto-update:** ผ่าน GitHub releases (`owner: stablyai`, `repo: orca`, `releaseType: draft`)

**ส่วนประกอบใน bundle:**

| ส่วน | ชนิด | หน้าที่ (อนุมานจากชื่อและโครงสร้าง) |
|---|---|---|
| `MacOS/Orca` | Electron main | แอปหลัก |
| `Helpers/Orca Terminal Host.app` (`orca-terminal-host`) | Native helper | โปรเซสโฮสต์เทอร์มินัล (PTY) |
| `Resources/Orca Computer Use.app` (`orca-computer-use-macos`) | Native helper | ให้ agent ควบคุมหน้าจอ เมาส์ และคีย์บอร์ด |
| `Resources/agent-browser-darwin-arm64` | Mach-O arm64 | ให้ agent ควบคุมเบราว์เซอร์ |
| `Resources/bin/orca` | Bash script | CLI ที่เรียก Electron binary |
| `Resources/ripgrep` | Binary | ค้นหาไฟล์ |
| `Resources/relay`, `orcad-template` | — | ระบบ relay และ daemon |
| `Resources/skills`, `plugins` | — | skill และ plugin ของ agent |
| `Resources/onboarding`, `native-chat-visuals` | — | asset สำหรับ onboarding และแชต |

**`app.asar`** (SHA-256 `264ce569…2923`) มี 6,548 entry แบ่งเป็น

| โฟลเดอร์ | จำนวน entry | เนื้อหา |
|---|---|---|
| `out/` | 5,825 | โค้ดที่ compile แล้ว ได้แก่ `cli`, `main`, `preload`, `renderer`, `web`, `mobile-web`, `shared` และ `packages` |
| `cloud/` | 662 | **source ฝั่ง backend** (ดูหัวข้อ 4.4) |
| `resources/` | 52 | ไอคอน เสียง และโลโก้ของ agent ต่างๆ |
| ไฟล์ที่ root | 7 | `package.json`, `components.json`, `orca.yaml`, `opencode.json`, `vite.web.config.ts`, `pnpm-workspace.yaml` และ `LICENSE` |

โลโก้ใน `resources/` บ่งว่าแอปรองรับ agent หลายเจ้า ได้แก่ Claude, OpenCode, OpenClaude, MiniMax, Ghostty และ Gremlin

### 4.2 Code Signature และ Entitlements

Evidence: `ev_deeb582c21bd6f104e4a118fdf2e76d9d62531b07b7e38c5a287e0a2edfa972c`

| Entitlement | ค่า | หมายเหตุ |
|---|---|---|
| `cs.allow-jit` | true | V8 |
| `cs.allow-unsigned-executable-memory` | true | เปิดกว้างกว่า JIT ปกติ |
| `cs.allow-dyld-environment-variables` | true | รับ `DYLD_*` แต่ library validation ยังเปิดอยู่ จึงกันการโหลด dylib ที่ไม่ได้เซ็นโดย team เดียวกันไว้ได้ (อนุมาน) |
| `device.camera` | true | |
| `device.audio-input` | true | ใช้กับฟีเจอร์ Dictation |
| `device.bluetooth` | true | |
| `device.usb` | true | อาจใช้กับ Android emulator หรืออุปกรณ์ (อนุมานจากคำสั่ง `emulator-logcat` ใน CLI) |
| `personal-information.location` | true | ไม่พบเหตุผลชัดเจน |
| `automation.apple-events` | true | สั่งงานแอปอื่นได้ |

**ประเมิน:** ขอสิทธิ์กว้างที่สุดในสามแอป เมื่อรวมกับ helper "Computer Use" ด้วยแล้ว Orca มีความสามารถเข้าถึงระบบได้มากที่สุด ซึ่งสอดคล้องกับหน้าที่ของแอปที่ให้ AI agent ทำงานแทนผู้ใช้

### 4.3 Electron Fuses

Evidence: `ev_0261dc2c85552e095d5c7446ab9158682955ef0e46492d0bfe004ba1cfd0f965`

ตั้งค่าเหมือน VS Code ทุกข้อ (ดูหัวข้อ 3.3) ได้แก่ RunAsNode เปิด, NODE_OPTIONS เปิด, `--inspect` เปิด, ไม่ตรวจความถูกต้องของ ASAR, ไม่บังคับโหลดจาก ASAR และไม่เข้ารหัส cookie

ความต่างคือ Orca ใช้ `app.asar` เป็นหลัก ถ้าเปิด `EnableEmbeddedAsarIntegrityValidation` และ `OnlyLoadAppFromAsar` ได้จะปลอดภัยขึ้นมาก แต่ต้องตรวจก่อนว่า CLI ที่เรียก `ELECTRON_RUN_AS_NODE` จะยังทำงานได้หรือไม่ (อนุมาน)

### 4.4 ข้อค้นพบ: ฝัง source ฝั่ง cloud มาในแอป

ใน `app.asar` มีไฟล์ที่ไม่ควรติดมากับแอปฝั่งผู้ใช้:

| หมวด | ตัวอย่าง |
|---|---|
| Service source | `cloud/apps/relay`, `cloud/apps/push`, `cloud/apps/relay-fence-broker`, `cloud/apps/relay-ops` |
| Infrastructure | `cloud/infra/terraform/` (มี `.terraform.lock.hcl`), Dockerfile 3 ไฟล์, `.dockerignore` |
| สคริปต์ ops | `relay-gce-terraform-fence.mjs`, `capture-terraform-plan-baseline.mjs` |
| เอกสารภายใน | `orca-relay-operations.md`, `relay-incident-monitor.md`, `relay-database-failure-diagnostics.md`, `relay-roll2-plan-2026-09.md`, `staging-relay-deploy-identity-rollout.md` และอื่นๆ รวม 13 ไฟล์ |
| โค้ดเกี่ยวกับ credential | `credential-store.ts`, `credential-store-cleanup.test.ts` |
| ไฟล์ test | ไฟล์ `.test.ts`/`.test.js` 220 ไฟล์ และ `.ts` ทั้งหมด 401 ไฟล์ |

**ขอบเขตการตรวจ:**
- ตรวจจากชื่อไฟล์อย่างเดียว ไม่พบไฟล์ `.env`, `.pem` หรือ key
- **ยังไม่ได้เปิดอ่านเนื้อไฟล์** เพื่อหา secret ที่ hard-code ไว้
- repo `stablyai/orca` บน GitHub อาจเป็น open source (ยังไม่ได้ยืนยัน) ถ้าใช่ ปัญหานี้จะเป็นเรื่องความสะอาดของแพ็กเกจและขนาดไฟล์มากกว่าการรั่วไหล แต่เอกสาร incident และ ops ยังทำให้ผู้โจมตีเห็นโครงสร้างระบบ cloud ได้

### 4.5 ผลวิเคราะห์ JavaScript (ไม่ครบ)

Evidence (partial): `ev_21942383471bd6a931a9719040ff5fb1173778ae71b3dc7dfef223bebf91be75`

REA วิเคราะห์ไม่จบเพราะหน่วยความจำของ parent process หมด (`resource_constraint`) เท่าที่ได้มาเป็นดังนี้

| ตัวชี้วัด | ค่า |
|---|---|
| ไฟล์ที่เกี่ยวข้อง | 5,754 |
| JavaScript ที่ parse ได้ | 3,914 (parse ไม่ผ่าน 1 ไฟล์) |
| AST node ที่ไล่ดู | 11,165,728 |
| Finding | 40,872 |
| Context bridge API | 1 |
| จุดที่ส่ง IPC | 1,056 (channel ที่เป็นข้อความตายตัว 1,031, channel ที่สร้างแบบ dynamic 21) |
| ฝั่ง renderer ส่ง / ฟัง | 862 / 194 |
| จุดที่ตรวจผู้ส่ง IPC (sender validation) | 9 |
| main handler ที่ระบุได้ | 0 |

**ข้อควรระวังในการตีความ:**
- "main handler = 0" **ไม่ได้แปลว่าไม่มี handler** แต่เป็นผลจากการวิเคราะห์ไม่ครบ
- ยังเหลือ application unknowns 8,546 รายการ และ semantic unknowns 99,670 รายการ

### 4.6 UX/UI

**Stack:**
- React + shadcn/ui สไตล์ `new-york-v4`, base color `neutral`, ใช้ CSS variables
- Tailwind CSS
- i18next / react-i18next
- Monaco Editor (ตัวเดียวกับ VS Code)
- xterm.js 6.1 beta (headless และ serialize addon)
- KaTeX และ Mermaid
- ฟอนต์: **Geist Variable** (UI), **Symbols Nerd Font Mono** (ไอคอนในเทอร์มินัล) และ SF Mono (โค้ด)

**Design tokens** (จาก CSS ที่ bundle แล้ว):

| Token | Light | Dark |
|---|---|---|
| `--background` | `#fff` | `#0a0a0a` |
| `--foreground` | `#0a0a0a` | `#fafafa` |
| `--primary` | `#171717` | `#e5e5e5` |
| `--accent` | `#f5f5f5` | `#404040` |
| `--sidebar` | `#fafafa` | `#171717` |
| `--radius` | `.625rem` (10px) | — |

มี token ชุดพิเศษ `--orca-security-*` สำหรับหน้าจอด้านความปลอดภัย และ `--worktree-sidebar-*` สำหรับ sidebar

**Accessibility ใน CSS:**
- `prefers-reduced-motion`: 12 จุด ลดแอนิเมชันตามที่ผู้ใช้ตั้งไว้ในระบบ
- `forced-colors`: 2 จุด
- ยังไม่มีธีม High Contrast เฉพาะของแอป

**ภาษา:** `SUPPORTED_UI_LOCALES = ['en','zh','ko','ja','es','fr']`
- ภาษาจีนตัวเต็ม (`zh-TW`, `zh-HK`, `zh-Hant`) จะ **fallback เป็นภาษาอังกฤษ** ไม่ใช่จีนตัวย่อ
- **ไม่มีภาษาไทย**

**โครงสร้างหน้าจอ** อนุมานจากชื่อ component ที่แยกโหลดทีละชิ้น (lazy chunk) ราว 120 ตัว:

| พื้นที่ | Component หลัก |
|---|---|
| หน้าหลักและ Dashboard | `Landing`, `App`, `TaskPage`, `WorkspaceSpacePage`, `ArtifactsPage`, `AutomationsPage`, `SkillsPage`, `MobilePage` |
| การจัดการ agent (หัวใจของแอป) | `AgentKanbanBoard`, `SidebarAgentsList`, `AgentDashboardSidebarHost`, `AgentStateDot`, `AgentCombobox`, `AgentQuestionIcon`, `AgentSessionContinuationDialog` |
| Git worktree | `WorktreeCreationPanel`, `WorktreeJumpPalette`, `WorktreeCardHelpers`, `DeleteWorktreeDialog`, `WorkspaceCleanupDialog`, `BaseRefPicker`, `DetachedHeadBadge` |
| Code review | `DiffViewer`, `CombinedDiffViewer`, `ImageDiffViewer`, `DiffCommentCard`, `DiffCommentPopover`, `ChecksPanel`, `SourceControl`, `PreservedBranchBatchReviewModal` |
| Editor และตัวดูไฟล์ | `MonacoEditor`, `EditorPanel`, `FileExplorer`, `QuickOpen`, `MarkdownPreview`, `RichMarkdownEditor`, `MermaidViewer`, `CsvViewer`, `IpynbViewer`, `ImageViewer`, `MediaViewer` |
| เทอร์มินัล | `Terminal`, `FloatingTerminalPanel`, `OnboardingInlineCommandTerminal` |
| Remote / SSH | `AddRemoteHostDialog`, `SshTargetCard`, `SshPassphraseDialog`, `RemoteServerUpdateDialog` |
| Status bar | `StatusBar`, `PortsStatusSegment`, `SshStatusSegment`, `ResourceUsageStatusSegment`, `PetStatusSegment` |
| Onboarding | `OnboardingFlow`, `ContextualTourOverlay`, `FeatureWallModal`, `FeatureWallSetupChecklist`, `SetupGuideModal`, `FeatureTipsModal`, `IntegrationsStep`, `NotificationStep` |
| Integration | `JiraIcon`, `LinearIcon`, `LinearAgentSkillSetupDialog`, `AiVaultPanel`, `PluginPanel` |
| ลูกเล่น | `PetOverlay` (สัตว์เลี้ยงบนจอ), `DictationController` (สั่งงานด้วยเสียง) |
| ความเสถียร | `RecoverableRenderErrorBoundary`, `CrashReportDialogSurface` |

**จุดแข็ง:**
- Design system สอดคล้องกันทั้งแอป หน้าตาทันสมัย
- Onboarding ครบถ้วน ทั้ง tour, checklist และ setup guide
- เปิดดูไฟล์หลายชนิดได้ในแอปโดยไม่ต้องสลับไปแอปอื่น
- มีคีย์ลัดและ palette เช่น `WorktreeJumpPalette`, `QuickOpen` และ `ShortcutKeyCombo`

**จุดอ่อน:**
- modal และหน้าแนะนำฟีเจอร์มาก อาจรบกวนผู้ใช้ที่คล่องแล้ว
- มีหลายหน้าจอและหลายแนวคิดให้เรียนรู้ เช่น worktree, agent, automation, artifact และ skill
- ไม่มีภาษาไทย และไม่มีธีม High Contrast

---

## 5. DBeaver Community Edition

### 5.1 สถาปัตยกรรม

- **Launcher:** `Contents/MacOS/dbeaver` (Mach-O arm64) เป็น native launcher ของ Eclipse Equinox
- **JRE ที่แถมมา:** Java **25.0.4.1** (`Contents/Eclipse/jre`) ตัดให้เหลือเฉพาะ module ที่ใช้ (jlink) เช่น `java.sql`, `java.desktop`, `jdk.crypto.cryptoki` และ `jdk.security.jgss`
- **Platform:** Eclipse RCP 4.41 + SWT (widget ของ macOS จริง), OSGi Equinox และ p2 (ระบบอัปเดตและติดตั้ง plugin)
- **Plugin:** 335 bundle

| กลุ่ม | จำนวน |
|---|---|
| `org.jkiss.dbeaver.*` | 135 |
| `org.eclipse.equinox.*` | 45 |
| `org.eclipse.e4.*` | 25 |
| `org.eclipse.ui.*` | 17 |
| `org.eclipse.core.*` | 15 |
| อื่นๆ (OSGi, ECF, ASM, EMF, Felix, SWT, …) | ที่เหลือ |

**Driver ฐานข้อมูลที่ติดมา** ราว 60 ระบบ เช่น PostgreSQL, MySQL, Oracle, MSSQL, DB2 (LUW/i/zOS), SQLite, DuckDB, ClickHouse, Snowflake, BigQuery, Databricks, Spanner, Athena, HANA, Teradata, Vertica, Exasol, Trino, Hive, Greenplum, TiDB, OceanBase, StarRocks, Doris, **Kingbase, Dameng, GaussDB, GBase 8s** (ฐานข้อมูลจากจีน), IoTDB, Greptime, Timeplus และ CData

**โมดูลอื่นที่สำคัญ:**
- `model.ai`, `ui.ai`: ผู้ช่วย AI
- `net.ssh.jsch`, `net.ssh.sshj`: SSH tunnel มีให้เลือก 2 library
- `ui.editors.erd`: แผนภาพ ER
- `data.gis`: แสดงข้อมูลแผนที่
- `ui.dashboard`: dashboard
- `tasks.native`: งานเบื้องหลังแบบ native
- `model.lsm`: SQL parser

### 5.2 การตั้งค่า JVM (`dbeaver.ini`)

```
-Dosgi.requiredJavaVersion=21
-Xms64m  -Xmx1024m
--enable-native-access=ALL-UNNAMED
--sun-misc-unsafe-memory-access=allow
--add-opens=java.base/{java.io, java.lang, java.lang.reflect, java.net, java.nio,
  java.nio.charset, java.text, java.time, java.util, java.util.concurrent,
  java.util.concurrent.atomic, jdk.internal.vm, jdk.internal.misc,
  sun.nio.ch, sun.nio.fs, sun.security.ssl, sun.security.util}=ALL-UNNAMED
--add-opens=java.security.jgss/{sun.security.jgss, sun.security.krb5}=ALL-UNNAMED
--add-opens=java.desktop/{java.awt, java.awt.peer}=ALL-UNNAMED
--add-opens=java.sql/java.sql=ALL-UNNAMED
-XstartOnFirstThread
-Ddbeaver.distribution.type=dmg
```

**ตีความ (อนุมาน):**
- `--add-opens` 23 รายการ ทำลายการแยก module ของ Java (encapsulation) เกือบทั้งหมด ทั้ง SSL, Kerberos และ reflection น่าจะทำเพื่อให้ JDBC driver และ plugin เก่ายังทำงานได้
- `-Xmx1024m` อาจไม่พอเมื่อเปิด result set ใหญ่หรือ ERD ขนาดใหญ่ ผู้ใช้ควรรู้ว่าปรับได้

### 5.3 Code Signature และ Entitlements

Evidence: `ev_351fa13744b56c69403914285619b76f67a74adb0d211f207196ea40d5fee9a4`

| Entitlement | ค่า | ความเสี่ยง |
|---|---|---|
| `cs.disable-library-validation` | true | **สูง:** โหลด dylib ที่ไม่ได้เซ็นหรือเซ็นโดย team อื่นได้ |
| `cs.allow-dyld-environment-variables` | true | **สูง:** รับ `DYLD_INSERT_LIBRARIES` |
| `cs.debugger` | true | ปานกลาง: แอปเองทำหน้าที่ debugger ได้ |
| `cs.disable-executable-page-protection` | true | ปานกลาง: ปิดการป้องกัน W^X |
| `cs.allow-unsigned-executable-memory` | true | ปานกลาง |
| `cs.allow-jit` | true | จำเป็นสำหรับ JVM |
| `device.audio-input`, `device.microphone` | true | ไม่พบเหตุผลชัดเจน (อนุมาน: อาจเป็นค่า template หรือใช้กับฟีเจอร์เสียงของ AI) |

**ตีความ (อนุมาน):**
- **สิ่งที่ entitlements ชุดนี้ทำให้เป็นไปได้:** การตั้ง `disable-library-validation` คู่กับ `allow-dyld-environment-variables` ทำให้ใครก็ตามที่เปิด DBeaver ด้วย environment ที่ควบคุมได้ แทรก dylib เข้าไปในโปรเซสได้ จากนั้นจะอ่าน connection credential ที่ถอดรหัสแล้วในหน่วยความจำ และใช้สิทธิ์ TCC ที่ผู้ใช้เคยให้ DBeaver ไว้ เช่น การเข้าถึงไฟล์
- **เหตุผลที่น่าจะเป็น:** JVM และ JDBC driver บางตัวมี native library ที่ไม่ได้เซ็นโดย DBeaver

**ยังไม่ได้ทดลองจริง** ทั้งหมดข้างบนเป็นข้อสรุปจาก entitlements

### 5.4 UX/UI

**จำนวน UI ที่ plugin ของ DBeaver ประกาศไว้** (จาก `plugin.xml` ของ 132 bundle):

| ประเภท | จำนวน |
|---|---|
| Command | 265 |
| Handler | 330 |
| Keybinding | 145 (`defaultAcceleratorConfiguration` 119, **`keyboardOnlyKeyScheme` 16**, `defaultKeyScheme` 10) |
| หน้าตั้งค่า (preference page) | **107** |
| Menu contribution | 97 |
| Editor | 58 |
| Wizard | 19 |
| View | 18 |
| Perspective | **1** |

**ธีม:** มีแค่ Light และ Dark ของ Eclipse (`org.eclipse.e4.ui.css.theme.e4_default` / `e4_dark`) ไม่มี High Contrast แยก จึงต้องอาศัยการตั้งค่าของ macOS

**ภาษา:** มี 14 ภาษา ได้แก่ อังกฤษ, อาหรับ, เยอรมัน, สเปน, ฝรั่งเศส, อิตาลี, ญี่ปุ่น, เกาหลี, โปรตุเกส (บราซิล), โรมาเนีย, รัสเซีย, จีนตัวเต็ม, ยูเครน และจีนตัวย่อ **ไม่มีภาษาไทย**

**Editor เฉพาะทาง:** Data grid, SQL (มี SQL terminal), ERD, JSON, XML, Hex, Image, ACL, Locks, Session และ GIS

**จุดแข็ง:**
- ใช้ widget ของ macOS จริง จึงเข้ากับ VoiceOver และระบบได้ดีโดยธรรมชาติ (อนุมาน ยังไม่ได้ทดสอบ)
- มีหน้าจอหลักแบบเดียว ผู้ใช้ไม่ต้องสลับ perspective แบบ Eclipse IDE ทั่วไป
- มีชุดคีย์ลัด "keyboard only" สำหรับผู้ที่ไม่ใช้เมาส์
- ฟังก์ชันครบมาก

**จุดอ่อน:**
- หน้าตั้งค่า 107 หน้า หาตัวเลือกที่ต้องการได้ยาก
- หน้าตาแบบ desktop รุ่นเก่า ระยะห่างแน่นและไอคอนเล็ก
- ธีมมีให้เลือกน้อย
- เมนูแน่น เพราะมี command 265 ตัว
- ไม่มีภาษาไทย

---

## 6. เปรียบเทียบด้านความปลอดภัยของแพ็กเกจ

### 6.1 Entitlements

| Entitlement | VS Code | Orca | DBeaver |
|---|:-:|:-:|:-:|
| allow-jit | ✅ | ✅ | ✅ |
| allow-unsigned-executable-memory | — | ✅ | ✅ |
| disable-executable-page-protection | — | — | ⚠️ |
| allow-dyld-environment-variables | — | ⚠️ | ⚠️ |
| **disable-library-validation** | — | — | 🔴 |
| cs.debugger | — | — | ⚠️ |
| camera | ✅ | ✅ | — |
| microphone / audio-input | ✅ | ✅ | ✅ |
| bluetooth | — | ✅ | — |
| usb | — | ✅ | — |
| location | — | ✅ | — |
| apple-events | ✅ | ✅ | — |
| **จำนวนรวม** | **4** | **9** | **8** |

### 6.2 Electron Fuses (เฉพาะ VS Code และ Orca)

ตั้งค่าเหมือนกันทุกข้อ ถือเป็นค่าเริ่มต้นของ Electron ที่ไม่ได้ปรับให้เข้มขึ้น

| ความเสี่ยง | ที่มา |
|---|---|
| ใช้แอปเป็นตัวรัน Node.js | `RunAsNode` + `NODE_OPTIONS` |
| แก้ไขโค้ดของแอป | ไม่ตรวจความถูกต้องของ ASAR + ไม่บังคับโหลดจาก ASAR |
| debugger ต่อเข้า main process | `--inspect` |
| cookie บนดิสก์ไม่เข้ารหัส | `EnableCookieEncryption` ปิด |

**ปัจจัยบรรเทา:**
- macOS 13 ขึ้นไปมีระบบ App Management ป้องกันไม่ให้แอปอื่นแก้ไขไฟล์ใน `/Applications`
- Hardened Runtime ยังเปิดอยู่ในทุกแอป

### 6.3 ลำดับความเสี่ยงโดยรวม

1. **DBeaver:** แทรก library เข้าโปรเซสได้ง่ายที่สุด และเก็บ credential ฐานข้อมูล
2. **Orca:** ขอสิทธิ์ macOS กว้างที่สุด, ตั้งค่า fuses หลวม, ฝัง source ฝั่ง cloud และมีความสามารถ Computer Use
3. **VS Code:** ขอสิทธิ์น้อยที่สุด แต่ตั้งค่า fuses หลวม

---

## 7. เปรียบเทียบด้าน UX/UI

| ด้าน | VS Code | Orca | DBeaver |
|---|---|---|---|
| Rendering | DOM ที่เขียนเอง | React DOM | SWT native |
| Design system | ของ VS Code เอง (Codicon) | shadcn/ui + Tailwind | Eclipse e4 CSS |
| Typography | ฟอนต์ระบบ | Geist + SF Mono + Nerd Font | ฟอนต์ระบบ |
| จำนวนธีม | 19 + icon theme 3 ชุด | 2 (Light/Dark) | 2 (Light/Dark) |
| High Contrast | ✅ ทั้งมืดและสว่าง | ❌ (มี `forced-colors` บางส่วน) | ❌ (อาศัยระบบ) |
| Reduced motion | ✅ | ✅ (12 จุด) | ไม่เกี่ยว (native) |
| Screen reader | ✅ ละเอียดมาก (verbosity และ signals) | ยังไม่ทราบ (ต้องตรวจตอนรันจริง) | ✅ ผ่าน native widget (อนุมาน) |
| ใช้คีย์บอร์ดล้วน | ✅ Command Palette | ✅ QuickOpen และ Jump Palette | ✅ keyboard-only scheme |
| Onboarding | ปานกลาง (Walkthroughs) | ✅ ดีมาก | น้อย |
| จำนวนภาษา | ~14 ผ่าน Language Pack | 6 | 14 |
| ภาษาไทย | ✅ (ผ่าน Language Pack) | ❌ | ❌ |
| ความง่ายสำหรับมือใหม่ | ปานกลาง | สูง | ต่ำ |
| ความเหมาะกับผู้ใช้ขั้นสูง | สูงมาก | สูง | สูงมาก |
| ทิศทางของ UI | เน้น AI Chat/Agent มากขึ้น | AI agent เป็นหัวใจของแอป | เพิ่ม AI เป็นโมดูลเสริม |

**สรุป UX:**
- **VS Code:** ครบเครื่องที่สุดด้าน accessibility และการปรับแต่ง แต่ซับซ้อนขึ้นเรื่อยๆ จากฟีเจอร์ AI
- **Orca:** สวยและทันสมัยที่สุด และพาผู้ใช้ใหม่ได้ดี แต่มีแนวคิดใหม่ให้เรียนรู้มาก และยังขาด accessibility เชิงลึกกับภาษาไทย
- **DBeaver:** เน้นความครบของฟังก์ชัน แลกกับความง่าย หน้าตาเก่าที่สุด

---

## 8. ข้อเสนอแนะ

### สำหรับผู้ใช้หรือองค์กร

| # | ข้อเสนอแนะ | แอป |
|---|---|---|
| 1 | อย่าเปิด DBeaver จาก shell ที่ตั้ง `DYLD_*` ไว้ และพิจารณาใช้ secure storage (Keychain) แทนการเก็บรหัสผ่านใน workspace | DBeaver |
| 2 | ให้สิทธิ์ macOS เฉพาะที่จำเป็น และไม่จำเป็นต้องให้ Location กับ Bluetooth ถ้าไม่ได้ใช้ | Orca |
| 3 | ตรวจ System Settings → Privacy & Security เป็นระยะ ว่าแอปเหล่านี้ได้สิทธิ์อะไรไปแล้วบ้าง | ทุกแอป |
| 4 | ใน MDM ขององค์กร ให้ตรวจ `ELECTRON_RUN_AS_NODE` และ `NODE_OPTIONS` ที่ถูกตั้งผิดปกติ | VS Code, Orca |
| 5 | ถ้าเปิด result set ใหญ่ ให้เพิ่ม `-Xmx` ใน `dbeaver.ini` | DBeaver |

### สำหรับผู้พัฒนา (feedback ที่ส่งต่อได้)

| # | ข้อเสนอแนะ | แอป |
|---|---|---|
| 1 | ตัด `cloud/`, ไฟล์ `*.test.*`, ไฟล์ `.ts` และเอกสาร ops ออกจาก `app.asar` | Orca |
| 2 | เปิด `EnableEmbeddedAsarIntegrityValidation` และ `OnlyLoadAppFromAsar` และพิจารณาปิด `EnableNodeCliInspectArguments` | Orca |
| 3 | ทบทวน entitlement `personal-information.location`, `device.bluetooth` และ `device.usb` | Orca |
| 4 | เพิ่มภาษาไทย และธีม High Contrast | Orca, DBeaver |
| 5 | ทบทวน `disable-library-validation` เปลี่ยนไปเซ็น native library ที่แถมมาเอง หรือแยก driver ที่มี native code ไปรันในโปรเซสแยก | DBeaver |
| 6 | ลดจำนวน `--add-opens` ให้เหลือเท่าที่จำเป็น | DBeaver |

---

## 9. ข้อจำกัดและสิ่งที่ยังไม่ได้ตรวจ

| รายการ | สถานะ | เหตุผล |
|---|---|---|
| วิเคราะห์ JavaScript ของ Orca | ⚠️ ได้บางส่วน | REA ใช้หน่วยความจำหมดก่อนวิเคราะห์จบ |
| วิเคราะห์ JavaScript ของ VS Code | ❌ ยังไม่ได้ทำ | ใหญ่กว่า Orca ต้องเลือกวิเคราะห์เฉพาะไฟล์ (`source_paths`) |
| Decompile jar ของ DBeaver | ❌ ยังไม่ได้ทำ | วิเคราะห์เฉพาะ `plugin.xml` และ manifest |
| ภาพหน้าจอและโครงสร้าง accessibility ตอนรันจริง | ❌ ถูกปฏิเสธ | Orca ยังไม่ได้สิทธิ์ Screen Recording และ Accessibility (Claude Code รันอยู่ในเทอร์มินัลของ Orca) |
| หา secret ในไฟล์ `cloud/` ของ Orca | ❌ ยังไม่ได้ทำ | ตรวจจากชื่อไฟล์อย่างเดียว |
| Network traffic และ telemetry | ❌ ยังไม่ได้ทำ | ต้องดักจับระหว่างแอปทำงาน |
| วิธีเก็บ credential ของ DBeaver | ❌ ยังไม่ได้ทำ | ต้อง decompile `org.jkiss.dbeaver.model` / `registry` |
| ยืนยันว่า `DYLD_INSERT_LIBRARIES` ใช้ได้จริงกับ DBeaver | ❌ ยังไม่ได้ทดลอง | เป็นการอนุมานจาก entitlements |
| Signature ของ helper app (Code Helper, Orca Helper, Computer Use) | ❌ ยังไม่ได้ทำ | ตรวจเฉพาะ executable หลัก |

**ข้อควรระวังทั่วไป:**
- ผลทั้งหมดได้จากการอ่านไฟล์ (static) ไม่ได้สังเกตการทำงานจริง
- Entitlement หรือ fuse ที่เปิดอยู่บอกได้แค่ว่า "ทำได้" ไม่ได้บอกว่าแอป "ทำจริง"
- จำนวน finding หรือ handler ที่เป็นศูนย์ในผลที่วิเคราะห์ไม่ครบ ไม่ได้แปลว่าไม่มี

---

## 10. ภาคผนวก: Evidence IDs และวิธีทำซ้ำ

### 10.1 Evidence IDs (REA)

| การตรวจ | Evidence ID |
|---|---|
| VS Code: Electron fuses | `ev_1f70b1115e0cdd9e0e329020aa1b00828ae38ceef6c0cca9f52691b5e1b6eaf2` |
| VS Code: Code signature | `ev_7fed1194b383c4b7e57662f5b9d743acc9140c3b80c47caec81eaec1e1f23f48` |
| Orca: Electron fuses | `ev_0261dc2c85552e095d5c7446ab9158682955ef0e46492d0bfe004ba1cfd0f965` |
| Orca: Code signature | `ev_deeb582c21bd6f104e4a118fdf2e76d9d62531b07b7e38c5a287e0a2edfa972c` |
| Orca: JavaScript analysis (partial) | `ev_21942383471bd6a931a9719040ff5fb1173778ae71b3dc7dfef223bebf91be75` |
| Orca: JavaScript summary view | `ev_377f7fd4f82f412a2e71f1bb54bd630bdaaec950165d7211f2f2ad7563eae359` |
| DBeaver: Code signature | `ev_351fa13744b56c69403914285619b76f67a74adb0d211f207196ea40d5fee9a4` |

> Evidence ที่ REA เก็บไว้ใช้ได้เฉพาะใน session ที่สร้างมัน ถ้าต้องการใช้ภายหลังให้ export ด้วย `export_evidence_bundle`

### 10.2 SHA-256 ของไฟล์ที่วิเคราะห์

| ไฟล์ | SHA-256 |
|---|---|
| `Visual Studio Code.app/Contents/MacOS/Code` | `f06b65cad79da1e11f658f1402f9b92078624d05787eb0166619349137e5b797` |
| VS Code: `Electron Framework` | `321966c74215e3786e06da14011a47106528703e12cb615da192e89524769d74` |
| `Orca.app/Contents/MacOS/Orca` | `faec6466360b0e8f668166654971b08cece6e131c13753803811555d475a70b5` |
| Orca: `Electron Framework` | `17663a2ee74bbfceceeeecf80fd07659cf4c2fbb3555f1140f3058e7e620e6b8` |
| Orca: `app.asar` | `264ce56953498362f9d929644ea40f124f1581195733518584d104a790832923` |
| `DBeaver.app/Contents/MacOS/dbeaver` | `58f3cb3189f07a2a17beb2b26a48ab7829d99701b8caad6f356bae2aaab0ea9d` |

### 10.3 คำสั่งที่ใช้ทำซ้ำได้

```bash
# Electron fuses (REA MCP)
inspect_electron_fuses { "path": "/Applications/Orca.app" }

# Code signature (REA MCP)
open_binary { "path": "/Applications/Orca.app/Contents/MacOS/Orca" }
inspect_signature {}

# JavaScript graph (REA MCP)
analyze_javascript_application {
  "input_path": "/Applications/Orca.app/Contents/Resources/app.asar",
  "detail": "summary"
}

# รายชื่อไฟล์ใน ASAR
npx -y @electron/asar@3.2.17 list /Applications/Orca.app/Contents/Resources/app.asar

# ตรวจ entitlements ด้วยเครื่องมือของ macOS
codesign -d --entitlements :- /Applications/DBeaver.app/Contents/MacOS/dbeaver

# อ่าน plugin.xml ของ DBeaver
unzip -p /Applications/DBeaver.app/Contents/Eclipse/plugins/org.jkiss.dbeaver.ui_*.jar plugin.xml
```
