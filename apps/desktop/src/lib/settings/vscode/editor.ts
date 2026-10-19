// VS Code settings: editor.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const EDITOR_SETTINGS: SettingSchema[] = [
	{
		id: 'editor.acceptSuggestionOnCommitCharacter',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ยอมรับคำแนะนำเมื่อพิมพ์อักขระ commit เช่นเซมิโคลอนใน JavaScript (Controls whether suggestions should be accepted on commit characters. For example, in JavaScript, the semi-colon (`;`) can be a commit character that accepts a suggestion and types that character.)'
	},
	{
		id: 'editor.acceptSuggestionOnEnter',
		group: 'Text Editor',
		type: 'string',
		default: 'on',
		enum: ['on', 'smart', 'off'],
		enumDescriptions: [
			'Enter รับคำแนะนำ',
			'รับเมื่อทำให้ข้อความเปลี่ยน (Only accept a suggestion with `Enter` when it makes a textual change.)',
			'ใช้ Tab เท่านั้น'
		],
		description: 'กด Enter เพื่อรับคำแนะนำ (Controls whether suggestions should be accepted on `Enter`, in addition to `Tab`. Helps to avoid ambiguity between inserting new lines or accepting suggestions.)'
	},
	{
		id: 'editor.accessibilityPageSize',
		group: 'Text Editor',
		type: 'number',
		default: 500,
		minimum: 1,
		maximum: 1073741824,
		integer: true,
		description: 'จำนวนบรรทัดที่โปรแกรมอ่านหน้าจออ่านได้ในครั้งเดียว (Controls the number of lines in the editor that can be read out by a screen reader at once. When we detect a screen reader we automatically set the default to be 500. Warning: this has a performance implication for numbers larger than the default.)'
	},
	{
		id: 'editor.accessibilitySupport',
		group: 'Text Editor',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'on', 'off'],
		enumDescriptions: [
			'Use platform APIs to detect when a Screen Reader is attached.',
			'Optimize for usage with a Screen Reader.',
			'Assume a screen reader is not attached.'
		],
		description: 'โหมดที่ปรับ editor ให้เหมาะกับโปรแกรมอ่านหน้าจอ (Controls if the UI should run in a mode where it is optimized for screen readers.)'
	},
	{
		id: 'editor.allowVariableFonts',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'อนุญาตฟอนต์แบบ variable ใน editor (Controls whether to allow using variable fonts in the editor.)'
	},
	{
		id: 'editor.allowVariableFontsInAccessibilityMode',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'อนุญาตฟอนต์แบบ variable ในโหมดช่วยการเข้าถึง (Controls whether to allow using variable fonts in the editor in the accessibility mode.)'
	},
	{
		id: 'editor.allowVariableLineHeights',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'อนุญาตให้แต่ละบรรทัดสูงไม่เท่ากัน (Controls whether to allow using variable line heights in the editor.)'
	},
	{
		id: 'editor.autoClosingBrackets',
		group: 'Text Editor',
		type: 'string',
		default: 'languageDefined',
		enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
		enumDescriptions: [
			'',
			'Use language configurations to determine when to autoclose brackets.',
			'Autoclose brackets only when the cursor is to the left of whitespace.',
			''
		],
		description: 'ปิดวงเล็บให้อัตโนมัติ (Controls whether the editor should automatically close brackets after the user adds an opening bracket.)'
	},
	{
		id: 'editor.autoClosingComments',
		group: 'Text Editor',
		type: 'string',
		default: 'languageDefined',
		enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
		enumDescriptions: [
			'',
			'Use language configurations to determine when to autoclose comments.',
			'Autoclose comments only when the cursor is to the left of whitespace.',
			''
		],
		description: 'ปิด comment ให้อัตโนมัติเมื่อพิมพ์ตัวเปิด comment (Controls whether the editor should automatically close comments after the user adds an opening comment.)'
	},
	{
		id: 'editor.autoClosingDelete',
		group: 'Text Editor',
		type: 'string',
		default: 'auto',
		enum: ['always', 'auto', 'never'],
		enumDescriptions: ['', 'Remove adjacent closing quotes or brackets only if they were automatically inserted.', ''],
		description: 'ลบวงเล็บหรือเครื่องหมายคำพูดตัวปิดที่ติดกันไปพร้อมกันเมื่อลบตัวเปิด (Controls whether the editor should remove adjacent closing quotes or brackets when deleting.)'
	},
	{
		id: 'editor.autoClosingOvertype',
		group: 'Text Editor',
		type: 'string',
		default: 'auto',
		enum: ['always', 'auto', 'never'],
		enumDescriptions: ['', 'Type over closing quotes or brackets only if they were automatically inserted.', ''],
		description: 'พิมพ์ทับวงเล็บหรือเครื่องหมายคำพูดตัวปิดแทนการแทรกเพิ่ม (Controls whether the editor should type over closing quotes or brackets.)'
	},
	{
		id: 'editor.autoClosingQuotes',
		group: 'Text Editor',
		type: 'string',
		default: 'languageDefined',
		enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
		enumDescriptions: [
			'',
			'Use language configurations to determine when to autoclose quotes.',
			'Autoclose quotes only when the cursor is to the left of whitespace.',
			''
		],
		description: 'ปิดเครื่องหมายคำพูดให้อัตโนมัติ (Controls whether the editor should automatically close quotes after the user adds an opening quote.)'
	},
	{
		id: 'editor.autoIndent',
		group: 'Text Editor',
		type: 'string',
		default: 'full',
		enum: ['none', 'keep', 'brackets', 'advanced', 'full'],
		enumDescriptions: [
			'The editor will not insert indentation automatically.',
			'The editor will keep the current line\'s indentation.',
			'The editor will keep the current line\'s indentation and honor language defined brackets.',
			'The editor will keep the current line\'s indentation, honor language defined brackets and invoke special onEnterRules defined by languages.',
			'The editor will keep the current line\'s indentation, honor language defined brackets, invoke special onEnterRules defined by languages, and honor indentationRules defined by languages.'
		],
		description: 'ปรับการเยื้องอัตโนมัติเมื่อพิมพ์ วาง หรือย้ายบรรทัด (Controls whether the editor should automatically adjust the indentation when users type, paste, move or indent lines.)'
	},
	{
		id: 'editor.autoIndentOnPaste',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จัดย่อหน้าเนื้อหาที่วางให้อัตโนมัติ (Controls whether the editor should automatically auto-indent the pasted content.)'
	},
	{
		id: 'editor.autoIndentOnPasteWithinString',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'จัดย่อหน้าอัตโนมัติแม้วางลงภายในสตริง เมื่อเปิด autoIndentOnPaste (Controls whether the editor should automatically auto-indent the pasted content when pasted within a string. This takes effect when autoIndentOnPaste is true.)'
	},
	{
		id: 'editor.autoSurround',
		group: 'Text Editor',
		type: 'string',
		default: 'languageDefined',
		enum: ['languageDefined', 'quotes', 'brackets', 'never'],
		enumDescriptions: [
			'Use language configurations to determine when to automatically surround selections.',
			'Surround with quotes but not brackets.',
			'Surround with brackets but not quotes.',
			''
		],
		description: 'ครอบข้อความที่เลือกเมื่อพิมพ์วงเล็บหรือเครื่องหมายคำพูด (Controls whether the editor should automatically surround selections when typing quotes or brackets.)'
	},
	{
		id: 'editor.bracketPairColorization.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ระบายสีวงเล็บเป็นคู่ (Controls whether bracket pair colorization is enabled or not. Use `#workbench.colorCustomizations#` to override the bracket highlight colors.)'
	},
	{
		id: 'editor.bracketPairColorization.independentColorPoolPerBracketType',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ให้วงเล็บแต่ละชนิดมีชุดสีของตัวเอง (Controls whether each bracket type has its own independent color pool.)'
	},
	{
		id: 'editor.codeActions.triggerOnFocusChange',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'รัน codeActionsOnSave แบบ always เมื่อโฟกัสเปลี่ยน ขณะ files.autoSave เป็น afterDelay (Enable triggering `#editor.codeActionsOnSave#` when `#files.autoSave#` is set to `afterDelay`. Code Actions must be set to `always` to be triggered for window and focus changes.)'
	},
	// VS Code's schema types the map values as strings but also accepts true/false (older settings files).
	{
		id: 'editor.codeActionsOnSave',
		group: 'Text Editor',
		type: 'json',
		schema: {
			type: ['object', 'array'],
			additionalProperties: { enum: ['always', 'explicit', 'never', true, false] },
			items: { type: 'string' }
		},
		default: {},
		description: 'code action ที่รันตอนบันทึก เช่น { "source.organizeImports": "explicit", "source.fixAll": "explicit" } — "explicit" เฉพาะบันทึกเอง, "always" รวมบันทึกอัตโนมัติด้วย (Run Code Actions for the editor on save. Code Actions must be specified and the editor must not be shutting down. When `#files.autoSave#` is set to `afterDelay`, Code Actions will only be run when the file is saved explicitly. Example: `"source.organizeImports": "explicit" `)'
	},
	{
		id: 'editor.codeActionWidget.includeNearbyQuickFixes',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง Quick Fix ที่ใกล้ที่สุดในบรรทัดแม้เคอร์เซอร์ไม่ได้อยู่บน diagnostic (Enable/disable showing nearest Quick Fix within a line when not currently on a diagnostic.)'
	},
	{
		id: 'editor.codeActionWidget.showHeaders',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงหัวกลุ่มในเมนู Code Action (Enable/disable showing group headers in the Code Action menu.)'
	},
	{
		id: 'editor.codeLens',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง CodeLens เหนือโค้ด (Controls whether the editor shows CodeLens.)'
	},
	{
		id: 'editor.codeLensFontFamily',
		group: 'Text Editor',
		type: 'string',
		default: '',
		description: 'ฟอนต์ของ CodeLens เว้นว่าง = ฟอนต์ของ editor (Controls the font family for CodeLens.)'
	},
	{
		id: 'editor.codeLensFontSize',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 100,
		integer: true,
		description: 'ขนาดฟอนต์ของ CodeLens 0 = 90% ของ editor.fontSize (Controls the font size in pixels for CodeLens. When set to 0, 90% of `#editor.fontSize#` is used.)'
	},
	{
		id: 'editor.colorDecorators',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวอย่างสีหน้าค่าสีและตัวเลือกสี (Controls whether the editor should render the inline color decorators and color picker.)'
	},
	{
		id: 'editor.colorDecoratorsActivatedOn',
		group: 'Text Editor',
		type: 'string',
		default: 'clickAndHover',
		enum: ['clickAndHover', 'hover', 'click'],
		enumDescriptions: [
			'Make the color picker appear both on click and hover of the color decorator',
			'Make the color picker appear on hover of the color decorator',
			'Make the color picker appear on click of the color decorator'
		],
		description: 'เงื่อนไขที่ตัวเลือกสีจะเปิดจากตัวอย่างสี (Controls the condition to make a color picker appear from a color decorator.)'
	},
	{
		id: 'editor.colorDecoratorsLimit',
		group: 'Text Editor',
		type: 'number',
		default: 500,
		minimum: 1,
		maximum: 1000000,
		integer: true,
		description: 'จำนวนตัวอย่างสีสูงสุดที่แสดงใน editor พร้อมกัน (Controls the max number of color decorators that can be rendered in an editor at once.)'
	},
	{
		id: 'editor.columnSelection',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ให้การเลือกด้วยเมาส์และคีย์บอร์ดเป็นการเลือกแบบคอลัมน์ (Enable that the selection with the mouse and keys is doing column selection.)'
	},
	{
		id: 'editor.comments.ignoreEmptyLines',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ข้ามบรรทัดว่างเมื่อสลับ เพิ่ม หรือลบ comment แบบบรรทัด (Controls if empty lines should be ignored with toggle, add or remove actions for line comments.)'
	},
	{
		id: 'editor.comments.insertSpace',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหนึ่งช่องหลังเครื่องหมาย comment (Controls whether a space character is inserted when commenting.)'
	},
	{
		id: 'editor.copyWithSyntaxHighlighting',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'คัดลอกสีไวยากรณ์ไปยังคลิปบอร์ดด้วย (Controls whether syntax highlighting should be copied into the clipboard.)'
	},
	{
		id: 'editor.cursorBlinking',
		group: 'Text Editor',
		type: 'string',
		default: 'blink',
		enum: ['blink', 'smooth', 'phase', 'expand', 'solid'],
		description: 'แอนิเมชันการกะพริบของเคอร์เซอร์ (Control the cursor animation style.)'
	},
	{
		id: 'editor.cursorHeight',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 1073741824,
		integer: true,
		description: 'ความสูงของเคอร์เซอร์เมื่อ cursorStyle เป็น line ค่า 0 คือเต็มบรรทัด (Controls the height of the cursor when `#editor.cursorStyle#` is set to `line`. Cursor\'s max height depends on line height.)'
	},
	{
		id: 'editor.cursorSmoothCaretAnimation',
		group: 'Text Editor',
		type: 'string',
		default: 'off',
		enum: ['off', 'explicit', 'on'],
		enumDescriptions: [
			'ปิด (Smooth caret animation is disabled.)',
			'เฉพาะเมื่อย้ายเคอร์เซอร์เอง (Smooth caret animation is enabled only when the user moves the cursor with an explicit gesture.)',
			'ทุกครั้ง (Smooth caret animation is always enabled.)'
		],
		description: 'แอนิเมชันเคอร์เซอร์แบบลื่น (Controls whether the smooth caret animation should be enabled.)'
	},
	{
		id: 'editor.cursorStyle',
		group: 'Text Editor',
		type: 'string',
		default: 'line',
		enum: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
		description: 'รูปแบบเคอร์เซอร์ (Controls the cursor style in insert input mode.)'
	},
	{
		id: 'editor.cursorSurroundingLines',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 1073741824,
		integer: true,
		description: 'จำนวนบรรทัดที่เห็นรอบเคอร์เซอร์อย่างน้อย (Controls the minimal number of visible leading lines (minimum 0) and trailing lines (minimum 1) surrounding the cursor. Known as \'scrollOff\' or \'scrollOffset\' in some other editors.)'
	},
	{
		id: 'editor.cursorSurroundingLinesStyle',
		group: 'Text Editor',
		type: 'string',
		default: 'default',
		enum: ['default', 'all'],
		enumDescriptions: [
			'`cursorSurroundingLines` is enforced only when triggered via the keyboard or API.',
			'`cursorSurroundingLines` is enforced always.'
		],
		description: 'เมื่อใดที่บังคับใช้ cursorSurroundingLines (Controls when `#editor.cursorSurroundingLines#` should be enforced.)'
	},
	{
		id: 'editor.cursorWidth',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 1073741824,
		integer: true,
		description: 'ความกว้างของเคอร์เซอร์เมื่อ cursorStyle เป็น line (Controls the width of the cursor when `#editor.cursorStyle#` is set to `line`.)'
	},
	{
		id: 'editor.defaultColorDecorators',
		group: 'Text Editor',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'always', 'never'],
		enumDescriptions: [
			'Show default color decorators only when no extension provides colors decorators.',
			'Always show default color decorators.',
			'Never show default color decorators.'
		],
		description: 'แสดงตัวอย่างสีด้วยตัวหาสีพื้นฐานของ editor (Controls whether inline color decorations should be shown using the default document color provider.)'
	},
	{
		id: 'editor.definitionLinkOpensInPeek',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ให้การคลิก Go to Definition ด้วยเมาส์เปิดหน้าต่าง peek เสมอ (Controls whether the Go to Definition mouse gesture always opens the peek widget.)'
	},
	{
		id: 'editor.doubleClickSelectsBlock',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ดับเบิลคลิกข้างวงเล็บหรือเครื่องหมายคำพูดเพื่อเลือกเนื้อหาข้างใน (Controls whether double-clicking next to a bracket or quote selects the content inside.)'
	},
	{
		id: 'editor.dragAndDrop',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ลากข้อความที่เลือกไปวางได้ (Controls whether the editor should allow moving selections via drag and drop.)'
	},
	{
		id: 'editor.dropIntoEditor.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ลากไฟล์มาวางในเนื้อหาของ editor ได้โดยกด Shift ค้างไว้ (Controls whether you can drag and drop a file into a text editor by holding down the `Shift` key (instead of opening the file in an editor).)'
	},
	{
		id: 'editor.dropIntoEditor.showDropSelector',
		group: 'Text Editor',
		type: 'string',
		default: 'afterDrop',
		enum: ['afterDrop', 'never'],
		enumDescriptions: [
			'Show the drop selector widget after a file is dropped into the editor.',
			'Never show the drop selector widget. Instead the default drop provider is always used.'
		],
		description: 'แสดงตัวเลือกวิธีวางหลังลากไฟล์มาวาง (Controls if a widget is shown when dropping files into the editor. This widget lets you control how the file is dropped.)'
	},
	{
		id: 'editor.editContext',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ใช้ EditContext API แทน textarea ในการรับข้อความ (Sets whether the EditContext API should be used instead of the text area to power input in the editor.)'
	},
	{
		id: 'editor.emptySelectionClipboard',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'คัดลอกโดยไม่ได้เลือก = คัดลอกทั้งบรรทัด (Controls whether copying without a selection copies the current line.)'
	},
	{
		id: 'editor.experimentalWhitespaceRendering',
		group: 'Text Editor',
		type: 'string',
		default: 'svg',
		enum: ['svg', 'font', 'off'],
		enumDescriptions: [
			'Use a new rendering method with svgs.',
			'Use a new rendering method with font characters.',
			'Use the stable rendering method.'
		],
		description: 'วิธีวาดอักขระช่องว่างแบบใหม่ (Controls whether whitespace is rendered with a new, experimental method.)'
	},
	{
		id: 'editor.fastScrollSensitivity',
		group: 'Text Editor',
		type: 'number',
		default: 5,
		description: 'ตัวคูณความเร็วการเลื่อนเมื่อกด Alt (Scrolling speed multiplier when pressing `Alt`.)'
	},
	{
		id: 'editor.find.addExtraSpaceOnTop',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เว้นที่ด้านบนเมื่อเปิดแถบค้นหา จะได้เลื่อนเลยบรรทัดแรกได้ (Controls whether the Find Widget should add extra lines on top of the editor. When true, you can scroll beyond the first line when the Find Widget is visible.)'
	},
	{
		id: 'editor.find.autoFindInSelection',
		group: 'Text Editor',
		type: 'string',
		default: 'never',
		enum: ['never', 'always', 'multiline'],
		enumDescriptions: [
			'Never turn on Find in Selection automatically (default).',
			'Always turn on Find in Selection automatically.',
			'Turn on Find in Selection automatically when multiple lines of content are selected.'
		],
		description: 'เมื่อใดที่เปิด Find in Selection ให้อัตโนมัติ (Controls the condition for turning on Find in Selection automatically.)'
	},
	{
		id: 'editor.find.closeOnResult',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ปิดแถบค้นหาเมื่อการไปยังผลลัพธ์ถัดไปเจอผล (Controls whether the Find Widget closes after an explicit find navigation command lands on a result.)'
	},
	{
		id: 'editor.find.cursorMoveOnType',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ย้ายเคอร์เซอร์ไปยังผลที่ตรงกันระหว่างพิมพ์คำค้นหา (Controls whether the cursor should jump to find matches while typing.)'
	},
	{
		id: 'editor.find.findOnType',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ค้นหาทันทีระหว่างพิมพ์ (Controls whether the Find Widget should search as you type.)'
	},
	{
		id: 'editor.find.history',
		group: 'Text Editor',
		type: 'string',
		default: 'workspace',
		enum: ['never', 'workspace'],
		enumDescriptions: [
			'Do not store search history from the find widget.',
			'Store search history across the active workspace'
		],
		description: 'วิธีเก็บประวัติคำค้นหา (Controls how the find widget history should be stored)'
	},
	{
		id: 'editor.find.loop',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ค้นหาวนกลับไปต้นไฟล์หรือท้ายไฟล์เมื่อไม่เจอผลถัดไป (Controls whether the search automatically restarts from the beginning (or the end) when no further matches can be found.)'
	},
	{
		id: 'editor.find.replaceHistory',
		group: 'Text Editor',
		type: 'string',
		default: 'workspace',
		enum: ['never', 'workspace'],
		enumDescriptions: [
			'Do not store history from the replace widget.',
			'Store replace history across the active workspace'
		],
		description: 'วิธีเก็บประวัติคำแทนที่ (Controls how the replace widget history should be stored)'
	},
	{
		id: 'editor.find.seedSearchStringFromSelection',
		group: 'Text Editor',
		type: 'string',
		default: 'always',
		enum: ['never', 'always', 'selection'],
		enumDescriptions: [
			'Never seed search string from the editor selection.',
			'Always seed search string from the editor selection, including word at cursor position.',
			'Only seed search string from the editor selection.'
		],
		description: 'ใช้ข้อความที่เลือกเป็นคำค้นหาเริ่มต้น (Controls whether the search string in the Find Widget is seeded from the editor selection.)'
	},
	{
		id: 'editor.folding',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'พับโค้ดได้ (Controls whether the editor has code folding enabled.)'
	},
	{
		id: 'editor.foldingHighlight',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ไฮไลต์ช่วงที่พับไว้ (Controls whether the editor should highlight folded ranges.)'
	},
	{
		id: 'editor.foldingImportsByDefault',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'พับช่วง import ให้อัตโนมัติ (Controls whether the editor automatically collapses import ranges.)'
	},
	{
		id: 'editor.foldingMaximumRegions',
		group: 'Text Editor',
		type: 'number',
		default: 5000,
		minimum: 10,
		maximum: 65000,
		integer: true,
		description: 'จำนวนช่วงที่พับได้สูงสุด (The maximum number of foldable regions. Increasing this value may result in the editor becoming less responsive when the current source has a large number of foldable regions.)'
	},
	{
		id: 'editor.foldingStrategy',
		group: 'Text Editor',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'indentation'],
		enumDescriptions: [
			'Use a language-specific folding strategy if available, else the indentation-based one.',
			'Use the indentation-based folding strategy.'
		],
		description: 'วิธีคำนวณช่วงที่พับได้ (Controls the strategy for computing folding ranges.)'
	},
	{
		id: 'editor.fontLigatures',
		group: 'Text Editor',
		type: 'json',
		schema: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
		default: false,
		description: 'เปิด font ligatures เช่น => เป็นลูกศร (Configures font ligatures or font features. Can be either a boolean to enable/disable ligatures or a string for the value of the CSS \'font-feature-settings\' property.)'
	},
	{
		id: 'editor.fontVariations',
		group: 'Text Editor',
		type: 'json',
		schema: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
		default: false,
		description: 'ตั้งค่า font variations ของฟอนต์แบบ variable (Configures font variations. Can be either a boolean to enable/disable the translation from font-weight to font-variation-settings or a string for the value of the CSS \'font-variation-settings\' property.)'
	},
	{
		id: 'editor.fontWeight',
		group: 'Text Editor',
		type: 'json',
		schema: {
			anyOf: [
				{ type: 'number', minimum: 1, maximum: 1000 },
				{ type: 'string', pattern: '^(normal|bold|1000|[1-9][0-9]{0,2})$' },
				{ enum: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] }
			]
		},
		default: 'normal',
		description: 'น้ำหนักตัวอักษรของ editor (Controls the font weight. Accepts "normal" and "bold" keywords or numbers between 1 and 1000.)'
	},
	{
		id: 'editor.formatOnPaste',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จัดรูปแบบข้อความที่วาง ต้องมี language server ที่จัดรูปแบบช่วงได้ (Controls whether the editor should automatically format the pasted content. A formatter must be available and the formatter should be able to format a range in a document.)'
	},
	{
		id: 'editor.formatOnSave',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จัดรูปแบบไฟล์ด้วย language server ตอนบันทึก (Format a file on save. A formatter must be available and the editor must not be shutting down. When `#files.autoSave#` is set to `afterDelay`, the file will only be formatted when saved explicitly.)'
	},
	{
		id: 'editor.formatOnType',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จัดรูปแบบบรรทัดหลังพิมพ์ (Controls whether the editor should automatically format the line after typing.)'
	},
	{
		id: 'editor.fullwidthCharacterWidth',
		group: 'Text Editor',
		type: 'string',
		default: 'font',
		enum: ['font', 'twoCells'],
		enumDescriptions: [
			'Render full-width characters using the width defined by the font.',
			'Render full-width characters centered in exactly two character cells. Only applies to monospace fonts when font ligatures are disabled. Does not apply to multi codepoint full-width characters or to GPU rendering. This has a performance impact on line rendering.'
		],
		description: 'ความกว้างที่ใช้วาดอักขระเต็มความกว้าง (Controls the width used to render full-width characters.)'
	},
	{
		id: 'editor.glyphMargin',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงขอบสำหรับ breakpoint (Controls whether the editor should render the vertical glyph margin. Glyph margin is mostly used for debugging.)'
	},
	{
		id: 'editor.gotoLocation.alternativeDeclarationCommand',
		group: 'Text Editor',
		type: 'string',
		default: 'editor.action.goToReferences',
		enum: [
			'',
			'editor.action.referenceSearch.trigger',
			'editor.action.goToReferences',
			'editor.action.peekImplementation',
			'editor.action.goToImplementation',
			'editor.action.peekTypeDefinition',
			'editor.action.goToTypeDefinition',
			'editor.action.peekDeclaration',
			'editor.action.revealDeclaration',
			'editor.action.peekDefinition',
			'editor.action.revealDefinitionAside',
			'editor.action.revealDefinition'
		],
		description: 'คำสั่งที่รันแทนเมื่อ Go to Declaration ได้ตำแหน่งปัจจุบัน (Alternative command id that is being executed when the result of \'Go to Declaration\' is the current location.)'
	},
	{
		id: 'editor.gotoLocation.alternativeDefinitionCommand',
		group: 'Text Editor',
		type: 'string',
		default: 'editor.action.goToReferences',
		enum: [
			'',
			'editor.action.referenceSearch.trigger',
			'editor.action.goToReferences',
			'editor.action.peekImplementation',
			'editor.action.goToImplementation',
			'editor.action.peekTypeDefinition',
			'editor.action.goToTypeDefinition',
			'editor.action.peekDeclaration',
			'editor.action.revealDeclaration',
			'editor.action.peekDefinition',
			'editor.action.revealDefinitionAside',
			'editor.action.revealDefinition'
		],
		description: 'คำสั่งที่รันแทนเมื่อ Go to Definition ได้ตำแหน่งปัจจุบัน (Alternative command id that is being executed when the result of \'Go to Definition\' is the current location.)'
	},
	{
		id: 'editor.gotoLocation.alternativeImplementationCommand',
		group: 'Text Editor',
		type: 'string',
		default: '',
		enum: [
			'',
			'editor.action.referenceSearch.trigger',
			'editor.action.goToReferences',
			'editor.action.peekImplementation',
			'editor.action.goToImplementation',
			'editor.action.peekTypeDefinition',
			'editor.action.goToTypeDefinition',
			'editor.action.peekDeclaration',
			'editor.action.revealDeclaration',
			'editor.action.peekDefinition',
			'editor.action.revealDefinitionAside',
			'editor.action.revealDefinition'
		],
		description: 'คำสั่งที่รันแทนเมื่อ Go to Implementation ได้ตำแหน่งปัจจุบัน (Alternative command id that is being executed when the result of \'Go to Implementation\' is the current location.)'
	},
	{
		id: 'editor.gotoLocation.alternativeReferenceCommand',
		group: 'Text Editor',
		type: 'string',
		default: '',
		enum: [
			'',
			'editor.action.referenceSearch.trigger',
			'editor.action.goToReferences',
			'editor.action.peekImplementation',
			'editor.action.goToImplementation',
			'editor.action.peekTypeDefinition',
			'editor.action.goToTypeDefinition',
			'editor.action.peekDeclaration',
			'editor.action.revealDeclaration',
			'editor.action.peekDefinition',
			'editor.action.revealDefinitionAside',
			'editor.action.revealDefinition'
		],
		description: 'คำสั่งที่รันแทนเมื่อ Go to Reference ได้ตำแหน่งปัจจุบัน (Alternative command id that is being executed when the result of \'Go to Reference\' is the current location.)'
	},
	{
		id: 'editor.gotoLocation.alternativeTypeDefinitionCommand',
		group: 'Text Editor',
		type: 'string',
		default: 'editor.action.goToReferences',
		enum: [
			'',
			'editor.action.referenceSearch.trigger',
			'editor.action.goToReferences',
			'editor.action.peekImplementation',
			'editor.action.goToImplementation',
			'editor.action.peekTypeDefinition',
			'editor.action.goToTypeDefinition',
			'editor.action.peekDeclaration',
			'editor.action.revealDeclaration',
			'editor.action.peekDefinition',
			'editor.action.revealDefinitionAside',
			'editor.action.revealDefinition'
		],
		description: 'คำสั่งที่รันแทนเมื่อ Go to Type Definition ได้ตำแหน่งปัจจุบัน (Alternative command id that is being executed when the result of \'Go to Type Definition\' is the current location.)'
	},
	{
		id: 'editor.gotoLocation.multipleDeclarations',
		group: 'Text Editor',
		type: 'string',
		default: 'peek',
		enum: ['peek', 'gotoAndPeek', 'goto'],
		enumDescriptions: [
			'Show Peek view of the results (default)',
			'Go to the primary result and show a Peek view',
			'Go to the primary result and enable Peek-less navigation to others'
		],
		description: 'สิ่งที่ Go to Declaration ทำเมื่อเจอหลายตำแหน่ง (Controls the behavior the \'Go to Declaration\'-command when multiple target locations exist.)'
	},
	{
		id: 'editor.gotoLocation.multipleDefinitions',
		group: 'Text Editor',
		type: 'string',
		default: 'peek',
		enum: ['peek', 'gotoAndPeek', 'goto'],
		enumDescriptions: [
			'Show Peek view of the results (default)',
			'Go to the primary result and show a Peek view',
			'Go to the primary result and enable Peek-less navigation to others'
		],
		description: 'สิ่งที่ Go to Definition ทำเมื่อเจอหลายตำแหน่ง (Controls the behavior the \'Go to Definition\'-command when multiple target locations exist.)'
	},
	{
		id: 'editor.gotoLocation.multipleImplementations',
		group: 'Text Editor',
		type: 'string',
		default: 'peek',
		enum: ['peek', 'gotoAndPeek', 'goto'],
		enumDescriptions: [
			'Show Peek view of the results (default)',
			'Go to the primary result and show a Peek view',
			'Go to the primary result and enable Peek-less navigation to others'
		],
		description: 'สิ่งที่ Go to Implementations ทำเมื่อเจอหลายตำแหน่ง (Controls the behavior the \'Go to Implementations\'-command when multiple target locations exist.)'
	},
	{
		id: 'editor.gotoLocation.multipleReferences',
		group: 'Text Editor',
		type: 'string',
		default: 'peek',
		enum: ['peek', 'gotoAndPeek', 'goto'],
		enumDescriptions: [
			'Show Peek view of the results (default)',
			'Go to the primary result and show a Peek view',
			'Go to the primary result and enable Peek-less navigation to others'
		],
		description: 'สิ่งที่ Go to References ทำเมื่อเจอหลายตำแหน่ง (Controls the behavior the \'Go to References\'-command when multiple target locations exist.)'
	},
	{
		id: 'editor.gotoLocation.multipleTypeDefinitions',
		group: 'Text Editor',
		type: 'string',
		default: 'peek',
		enum: ['peek', 'gotoAndPeek', 'goto'],
		enumDescriptions: [
			'Show Peek view of the results (default)',
			'Go to the primary result and show a Peek view',
			'Go to the primary result and enable Peek-less navigation to others'
		],
		description: 'สิ่งที่ Go to Type Definition ทำเมื่อเจอหลายตำแหน่ง (Controls the behavior the \'Go to Type Definition\'-command when multiple target locations exist.)'
	},
	{
		id: 'editor.guides.bracketPairs',
		group: 'Text Editor',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, 'active', false] },
		default: false,
		description: 'แสดงเส้นนำของคู่วงเล็บ (Controls whether bracket pair guides are enabled or not.)'
	},
	{
		id: 'editor.guides.bracketPairsHorizontal',
		group: 'Text Editor',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, 'active', false] },
		default: 'active',
		description: 'แสดงเส้นนำแนวนอนของคู่วงเล็บ (Controls whether horizontal bracket pair guides are enabled or not.)'
	},
	{
		id: 'editor.guides.highlightActiveBracketPair',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ไฮไลต์คู่วงเล็บที่เคอร์เซอร์อยู่ (Controls whether the editor should highlight the active bracket pair.)'
	},
	{
		id: 'editor.guides.highlightActiveIndentation',
		group: 'Text Editor',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, 'always', false] },
		default: true,
		description: 'ไฮไลต์เส้นย่อหน้าที่เคอร์เซอร์อยู่ (Controls whether the editor should highlight the active indent guide.)'
	},
	{
		id: 'editor.guides.indentation',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงเส้นนำการเยื้อง (Controls whether the editor should render indent guides.)'
	},
	{
		id: 'editor.hideCursorInOverviewRuler',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ซ่อนตำแหน่งเคอร์เซอร์ในแถบภาพรวมด้านขวา (Controls whether the cursor should be hidden in the overview ruler.)'
	},
	{
		id: 'editor.hover.above',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง hover เหนือบรรทัดถ้ามีที่ว่าง (Prefer showing hovers above the line, if there\'s space.)'
	},
	{
		id: 'editor.hover.delay',
		group: 'Text Editor',
		type: 'number',
		default: 300,
		minimum: 0,
		maximum: 10000,
		description: 'หน่วงเวลาเป็นมิลลิวินาทีก่อนแสดง hover (Controls the delay in milliseconds after which the hover is shown.)'
	},
	{
		id: 'editor.hover.enabled',
		group: 'Text Editor',
		type: 'string',
		default: 'on',
		enum: ['on', 'off', 'onKeyboardModifier'],
		enumDescriptions: [
			'Hover is enabled.',
			'Hover is disabled.',
			'Hover is shown when holding `Command` or `Alt` (the opposite modifier of `#editor.multiCursorModifier#`)'
		],
		description: 'แสดง hover (Controls whether the hover is shown.)'
	},
	{
		id: 'editor.hover.hidingDelay',
		group: 'Text Editor',
		type: 'number',
		default: 300,
		minimum: 0,
		integer: true,
		description: 'หน่วงเวลาเป็นมิลลิวินาทีก่อนซ่อน hover ต้องเปิด hover.sticky (Controls the delay in milliseconds after which the hover is hidden. Requires `#editor.hover.sticky#` to be enabled.)'
	},
	{
		id: 'editor.hover.showLongLineWarning',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง hover เตือนบรรทัดยาว เช่นเมื่อข้ามการ tokenize (Controls whether long line warning hovers are shown, such as when tokenization is skipped or rendering is paused.)'
	},
	{
		id: 'editor.hover.sticky',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ให้ hover ค้างอยู่เมื่อเลื่อนเมาส์ไปบนมัน (Controls whether the hover should remain visible when mouse is moved over it.)'
	},
	{
		id: 'editor.indentSize',
		group: 'Text Editor',
		type: 'json',
		schema: { anyOf: [{ type: 'string', enum: ['tabSize'] }, { type: 'number', minimum: 1 }] },
		default: 'tabSize',
		description: 'จำนวนช่องว่างของการย่อหน้า หรือ tabSize เพื่อใช้ค่าของ editor.tabSize (The number of spaces used for indentation or `"tabSize"` to use the value from `#editor.tabSize#`. This setting is overridden based on the file contents when `#editor.detectIndentation#` is on.)'
	},
	{
		id: 'editor.inertialScroll',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'เลื่อนแบบมีแรงเฉื่อย เหมาะกับทัชแพดบน Linux (Make scrolling inertial - mostly useful with touchpad on linux.)'
	},
	{
		id: 'editor.inlayHints.enabled',
		group: 'Text Editor',
		type: 'string',
		default: 'on',
		enum: ['on', 'onUnlessPressed', 'offUnlessPressed', 'off'],
		enumDescriptions: [
			'แสดง (Inlay hints are enabled)',
			'แสดงยกเว้นตอนกด Ctrl+Option ค้างไว้ (Inlay hints are showing by default and hide when holding Ctrl+Option)',
			'ซ่อนยกเว้นตอนกด Ctrl+Option ค้างไว้ (Inlay hints are hidden by default and show when holding Ctrl+Option)',
			'ไม่แสดง (Inlay hints are disabled)'
		],
		description: 'แสดง inlay hint ใน editor (Enables the inlay hints in the editor.)'
	},
	{
		id: 'editor.inlayHints.fontFamily',
		group: 'Text Editor',
		type: 'string',
		default: '',
		description: 'ฟอนต์ของ inlay hint เว้นว่าง = ฟอนต์ของ editor (Controls font family of inlay hints in the editor. When set to empty, the `#editor.fontFamily#` is used.)'
	},
	{
		id: 'editor.inlayHints.fontSize',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		description: 'ขนาดฟอนต์ของ inlay hint ค่าเริ่มต้น = 90% ของ editor.fontSize (Controls font size of inlay hints in the editor. As default the `#editor.fontSize#` is used when the configured value is less than `5` or greater than the editor font size.)'
	},
	{
		id: 'editor.inlayHints.maximumLength',
		group: 'Text Editor',
		type: 'number',
		default: 43,
		description: 'ความยาวสูงสุดของ inlay hint ต่อบรรทัด 0 = ไม่ตัด (Maximum overall length of inlay hints, for a single line, before they get truncated by the editor. Set to `0` to never truncate)'
	},
	{
		id: 'editor.inlayHints.padding',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'เว้นระยะรอบ inlay hint (Enables the padding around the inlay hints in the editor.)'
	},
	{
		id: 'editor.largeFileOptimizations',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'จัดการไฟล์ใหญ่เป็นพิเศษ ปิดความสามารถที่ใช้หน่วยความจำมาก (Special handling for large files to disable certain memory intensive features.)'
	},
	{
		id: 'editor.letterSpacing',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		description: 'ระยะห่างตัวอักษรเป็นพิกเซล (Controls the letter spacing in pixels.)'
	},
	{
		id: 'editor.lightbulb.enabled',
		group: 'Text Editor',
		type: 'string',
		default: 'onCode',
		enum: ['off', 'onCode', 'on'],
		enumDescriptions: [
			'Disable the code action menu.',
			'Show the code action menu when the cursor is on lines with code.',
			'Show the code action menu when the cursor is on lines with code or on empty lines.'
		],
		description: 'แสดงหลอดไฟ Code Action ใน editor (Enables the Code Action lightbulb in the editor.)'
	},
	{
		id: 'editor.lineHeight',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 150,
		description: 'ความสูงบรรทัด 0 = คำนวณจากขนาดตัวอักษร ค่าน้อยกว่า 8 คือตัวคูณของขนาดตัวอักษร (Controls the line height. \n - Use 0 to automatically compute the line height from the font size.\n - Values between 0 and 8 will be used as a multiplier with the font size.\n - Values greater than or equal to 8 will be used as effective values.)'
	},
	{
		id: 'editor.lineNumbers',
		group: 'Text Editor',
		type: 'string',
		default: 'on',
		enum: ['off', 'on', 'relative', 'interval'],
		enumDescriptions: [
			'ไม่แสดงเลขบรรทัด (Line numbers are not rendered.)',
			'แสดงเลขบรรทัด (Line numbers are rendered as absolute number.)',
			'แสดงระยะจากบรรทัดของเคอร์เซอร์ (Line numbers are rendered as distance in lines to cursor position.)',
			'แสดงทุก 10 บรรทัด (Line numbers are rendered every 10 lines.)'
		],
		description: 'การแสดงเลขบรรทัด (Controls the display of line numbers.)'
	},
	{
		id: 'editor.linkedEditing',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'แก้แท็กเปิด/ปิด HTML พร้อมกัน (Controls whether the editor has linked editing enabled. Depending on the language, related symbols such as HTML tags, are updated while editing.)'
	},
	{
		id: 'editor.links',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ตรวจหาลิงก์และทำให้คลิกได้ (Controls whether the editor should detect links and make them clickable.)'
	},
	{
		id: 'editor.matchBrackets',
		group: 'Text Editor',
		type: 'string',
		default: 'always',
		enum: ['always', 'near', 'never'],
		description: 'ไฮไลต์วงเล็บคู่ (Highlight matching brackets.)'
	},
	{
		id: 'editor.maxTokenizationLineLength',
		group: 'Text Editor',
		type: 'number',
		default: 20000,
		integer: true,
		description: 'บรรทัดที่ยาวเกินค่านี้จะไม่ถูก tokenize เพื่อประสิทธิภาพ (Lines above this length will not be tokenized for performance reasons)'
	},
	{
		id: 'editor.minimap.autohide',
		group: 'Text Editor',
		type: 'string',
		default: 'none',
		enum: ['none', 'mouseover', 'scroll'],
		enumDescriptions: [
			'The minimap is always shown.',
			'The minimap is hidden when mouse is not over the minimap and shown when mouse is over the minimap.',
			'The minimap is only shown when the editor is scrolled'
		],
		description: 'ซ่อน minimap อัตโนมัติ (Controls whether the minimap is hidden automatically.)'
	},
	{
		id: 'editor.minimap.markSectionHeaderRegex',
		group: 'Text Editor',
		type: 'string',
		default: '\\bMARK:\\s*(?<separator>-?)\\s*(?<label>.*)$',
		description: 'regex ที่ใช้หาหัวข้อส่วนใน comment (Defines the regular expression used to find section headers in comments. The regex must contain a named match group `label` (written as `(?<label>.+)`) that encapsulates the section header, otherwise it will not work. Optionally you can include another match group named `separator`. Use \\n in the pattern to match multi-line headers.)'
	},
	{
		id: 'editor.minimap.maxColumn',
		group: 'Text Editor',
		type: 'number',
		default: 120,
		description: 'จำกัดความกว้าง minimap เป็นจำนวนคอลัมน์สูงสุด (Limit the width of the minimap to render at most a certain number of columns.)'
	},
	{
		id: 'editor.minimap.renderCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวอักษรจริงใน minimap แทนบล็อกสี (Render the actual characters on a line as opposed to color blocks.)'
	},
	{
		id: 'editor.minimap.scale',
		group: 'Text Editor',
		type: 'json',
		schema: { type: 'number', enum: [1, 2, 3], minimum: 1, maximum: 3 },
		default: 1,
		description: 'สเกลของเนื้อหาใน minimap (Scale of content drawn in the minimap: 1, 2 or 3.)'
	},
	{
		id: 'editor.minimap.sectionHeaderFontSize',
		group: 'Text Editor',
		type: 'number',
		default: 9,
		description: 'ขนาดตัวอักษรของหัวข้อส่วนใน minimap (Controls the font size of section headers in the minimap.)'
	},
	{
		id: 'editor.minimap.sectionHeaderLetterSpacing',
		group: 'Text Editor',
		type: 'number',
		default: 1,
		description: 'ระยะห่างตัวอักษรของหัวข้อส่วนใน minimap (Controls the amount of space (in pixels) between characters of section header. This helps the readability of the header in small font sizes.)'
	},
	{
		id: 'editor.minimap.showMarkSectionHeaders',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง comment แบบ MARK: เป็นหัวข้อส่วนใน minimap (Controls whether MARK: comments are shown as section headers in the minimap.)'
	},
	{
		id: 'editor.minimap.showRegionSectionHeaders',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง region ที่มีชื่อเป็นหัวข้อส่วนใน minimap (Controls whether named regions are shown as section headers in the minimap.)'
	},
	{
		id: 'editor.minimap.showSlider',
		group: 'Text Editor',
		type: 'string',
		default: 'mouseover',
		enum: ['always', 'mouseover'],
		description: 'เมื่อใดที่แสดงแถบเลื่อนของ minimap (Controls when the minimap slider is shown.)'
	},
	{
		id: 'editor.minimap.side',
		group: 'Text Editor',
		type: 'string',
		default: 'right',
		enum: ['left', 'right'],
		description: 'ด้านที่แสดง minimap (Controls the side where to render the minimap.)'
	},
	{
		id: 'editor.minimap.size',
		group: 'Text Editor',
		type: 'string',
		default: 'proportional',
		enum: ['proportional', 'fill', 'fit'],
		enumDescriptions: [
			'The minimap has the same size as the editor contents (and might scroll).',
			'The minimap will stretch or shrink as necessary to fill the height of the editor (no scrolling).',
			'The minimap will shrink as necessary to never be larger than the editor (no scrolling).'
		],
		description: 'ขนาดของ minimap (Controls the size of the minimap.)'
	},
	{
		id: 'editor.mouseMiddleClickAction',
		group: 'Text Editor',
		type: 'string',
		default: 'default',
		enum: ['default', 'openLink', 'ctrlLeftClick'],
		description: 'สิ่งที่เกิดขึ้นเมื่อคลิกปุ่มกลางของเมาส์ใน editor (Controls what happens when middle mouse button is clicked in the editor.)'
	},
	{
		id: 'editor.mouseWheelScrollSensitivity',
		group: 'Text Editor',
		type: 'number',
		default: 1,
		description: 'ตัวคูณระยะเลื่อนของลูกล้อเมาส์ (A multiplier to be used on the `deltaX` and `deltaY` of mouse wheel scroll events.)'
	},
	{
		id: 'editor.mouseWheelZoom',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ซูมตัวอักษรด้วย ⌘ + ล้อเมาส์ (Zoom the font of the editor when using mouse wheel and holding `Cmd`.)'
	},
	{
		id: 'editor.multiCursorLimit',
		group: 'Text Editor',
		type: 'number',
		default: 10000,
		minimum: 1,
		maximum: 100000,
		integer: true,
		description: 'จำนวนเคอร์เซอร์สูงสุดใน editor (Controls the max number of cursors that can be in an active editor at once.)'
	},
	{
		id: 'editor.multiCursorMergeOverlapping',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'รวมเคอร์เซอร์ที่ซ้อนทับกัน (Merge multiple cursors when they are overlapping.)'
	},
	{
		id: 'editor.multiCursorModifier',
		group: 'Text Editor',
		type: 'string',
		default: 'alt',
		enum: ['ctrlCmd', 'alt'],
		enumDescriptions: [
			'⌘ บน macOS, Ctrl บนระบบอื่น (Maps to `Control` on Windows and Linux and to `Command` on macOS.)',
			'⌥ บน macOS, Alt บนระบบอื่น (Maps to `Alt` on Windows and Linux and to `Option` on macOS.)'
		],
		description: 'ปุ่มที่ใช้เพิ่มเคอร์เซอร์ด้วยเมาส์ (The modifier to be used to add multiple cursors with the mouse. The Go to Definition and Open Link mouse gestures will adapt such that they do not conflict with the [multicursor modifier](https://code.visualstudio.com/docs/editor/codebasics#_multicursor-modifier).)'
	},
	{
		id: 'editor.multiCursorPaste',
		group: 'Text Editor',
		type: 'string',
		default: 'spread',
		enum: ['spread', 'full'],
		enumDescriptions: [
			'Each cursor pastes a single line of the text. When pasting column selections into a single cursor, each copied line is pasted on a successive destination line and padded with spaces to form a rectangle.',
			'Each cursor pastes the full text.'
		],
		description: 'วิธีวางเมื่อจำนวนบรรทัดที่วางเท่ากับจำนวนเคอร์เซอร์ (Controls pasting when the line count of the pasted text matches the cursor count, or when pasting column selections into a single cursor.)'
	},
	{
		id: 'editor.occurrencesHighlight',
		group: 'Text Editor',
		type: 'string',
		default: 'singleFile',
		enum: ['off', 'singleFile', 'multiFile'],
		enumDescriptions: [
			'Does not highlight occurrences.',
			'Highlights occurrences only in the current file.',
			'Experimental: Highlights occurrences across all valid open files.'
		],
		description: 'ไฮไลต์คำเดียวกันในไฟล์นี้หรือในทุกไฟล์ที่เปิด (Controls whether occurrences should be highlighted across open files.)'
	},
	{
		id: 'editor.occurrencesHighlightDelay',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 2000,
		integer: true,
		description: 'หน่วงเวลาเป็นมิลลิวินาทีก่อนไฮไลต์คำเดียวกัน (Controls the delay in milliseconds after which occurrences are highlighted.)'
	},
	{
		id: 'editor.overtypeCursorStyle',
		group: 'Text Editor',
		type: 'string',
		default: 'block',
		enum: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
		description: 'รูปแบบเคอร์เซอร์ในโหมดพิมพ์ทับ (Controls the cursor style in overtype input mode.)'
	},
	{
		id: 'editor.overtypeOnPaste',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ให้การวางพิมพ์ทับข้อความในโหมดพิมพ์ทับ (Controls whether pasting should overtype.)'
	},
	{
		id: 'editor.overviewRulerBorder',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'วาดเส้นขอบรอบแถบภาพรวมด้านขวา (Controls whether a border should be drawn around the overview ruler.)'
	},
	{
		id: 'editor.padding.bottom',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 1000,
		description: 'ระยะว่างระหว่างขอบล่างของ editor กับบรรทัดสุดท้าย (Controls the amount of space between the bottom edge of the editor and the last line.)'
	},
	{
		id: 'editor.padding.top',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 1000,
		description: 'ระยะว่างระหว่างขอบบนของ editor กับบรรทัดแรก (Controls the amount of space between the top edge of the editor and the first line.)'
	},
	{
		id: 'editor.parameterHints.cycle',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ให้รายการ parameter hints วนกลับเมื่อถึงท้ายรายการ (Controls whether the parameter hints menu cycles or closes when reaching the end of the list.)'
	},
	{
		id: 'editor.parameterHints.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำใบ้พารามิเตอร์ขณะพิมพ์ (Enables a pop-up that shows parameter documentation and type information as you type.)'
	},
	{
		id: 'editor.pasteAs.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เลือกวิธีวางเนื้อหาได้หลายแบบ (Controls whether you can paste content in different ways.)'
	},
	{
		id: 'editor.pasteAs.showPasteSelector',
		group: 'Text Editor',
		type: 'string',
		default: 'afterPaste',
		enum: ['afterPaste', 'never'],
		enumDescriptions: [
			'Show the paste selector widget after content is pasted into the editor.',
			'Never show the paste selector widget. Instead the default pasting behavior is always used.'
		],
		description: 'แสดงตัวเลือกวิธีวางหลังวาง (Controls if a widget is shown when pasting content in to the editor. This widget lets you control how the file is pasted.)'
	},
	{
		id: 'editor.peekWidgetDefaultFocus',
		group: 'Text Editor',
		type: 'string',
		default: 'tree',
		enum: ['tree', 'editor'],
		enumDescriptions: ['Focus the tree when opening peek', 'Focus the editor when opening peek'],
		description: 'โฟกัส editor หรือรายการในหน้าต่าง peek (Controls whether to focus the inline editor or the tree in the peek widget.)'
	},
	{
		id: 'editor.quickSuggestions',
		group: 'Text Editor',
		type: 'json',
		schema: {
			anyOf: [
				{ type: 'boolean' },
				{ type: 'string', enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'] },
				{
					type: 'object',
					properties: {
						strings: {
							anyOf: [
								{ type: 'boolean' },
								{ type: 'string', enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'] }
							]
						},
						comments: {
							anyOf: [
								{ type: 'boolean' },
								{ type: 'string', enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'] }
							]
						},
						other: {
							anyOf: [
								{ type: 'boolean' },
								{ type: 'string', enum: ['on', 'inline', 'off', 'offWhenInlineCompletions'] }
							]
						}
					},
					additionalProperties: false
				}
			]
		},
		default: { other: 'offWhenInlineCompletions', comments: 'off', strings: 'off' },
		description: 'แสดงคำแนะนำอัตโนมัติขณะพิมพ์ในโค้ด (Controls whether suggestions should automatically show up while typing. This can be controlled for typing in comments, strings, and other code. Quick suggestion can be configured to show as ghost text or with the suggest widget. Also be aware of the `#editor.suggestOnTriggerCharacters#`-setting which controls if suggestions are triggered by special characters.)'
	},
	{
		id: 'editor.quickSuggestionsDelay',
		group: 'Text Editor',
		type: 'number',
		default: 10,
		minimum: 0,
		maximum: 1073741824,
		integer: true,
		description: 'หน่วงเวลาเป็นมิลลิวินาทีก่อนแสดงคำแนะนำอัตโนมัติ (Controls the delay in milliseconds after which quick suggestions will show up.)'
	},
	{
		id: 'editor.renderControlCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงอักขระควบคุม (Controls whether the editor should render control characters.)',
		scope: 'application'
	},
	{
		id: 'editor.renderFinalNewline',
		group: 'Text Editor',
		type: 'string',
		default: 'on',
		enum: ['off', 'on', 'dimmed'],
		description: 'แสดงเลขบรรทัดสุดท้ายเมื่อไฟล์จบด้วยการขึ้นบรรทัดใหม่ (Render last line number when the file ends with a newline.)'
	},
	{
		id: 'editor.renderLineHighlight',
		group: 'Text Editor',
		type: 'string',
		default: 'line',
		enum: ['none', 'gutter', 'line', 'all'],
		enumDescriptions: ['', '', '', 'Highlights both the gutter and the current line.'],
		description: 'การไฮไลต์บรรทัดปัจจุบัน (Controls how the editor should render the current line highlight.)'
	},
	{
		id: 'editor.renderLineHighlightOnlyWhenFocus',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ไฮไลต์บรรทัดปัจจุบันเฉพาะเมื่อ editor มีโฟกัส (Controls if the editor should render the current line highlight only when the editor is focused.)'
	},
	{
		id: 'editor.renderRichScreenReaderContent',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ส่งเนื้อหาแบบละเอียดให้โปรแกรมอ่านหน้าจอเมื่อเปิด editContext (Whether to render rich screen reader content when the `#editor.editContext#` setting is enabled.)'
	},
	{
		id: 'editor.roundedSelection',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ทำมุมการเลือกให้โค้งมน (Controls whether selections should have rounded corners.)'
	},
	{
		id: 'editor.rulers',
		group: 'Text Editor',
		type: 'json',
		schema: {
			type: 'array',
			items: {
				anyOf: [
					{ type: 'number' },
					{ type: ['object'], properties: { column: { type: 'number' }, color: { type: 'string' } } }
				]
			}
		},
		default: [],
		description: 'เส้นแนวตั้งที่คอลัมน์ที่กำหนด เช่น [80, 120] (Render vertical rulers after a certain number of monospace characters. Use multiple values for multiple rulers. No rulers are drawn if array is empty.)'
	},
	{
		id: 'editor.scrollbar.horizontal',
		group: 'Text Editor',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'visible', 'hidden'],
		enumDescriptions: [
			'The horizontal scrollbar will be visible only when necessary.',
			'The horizontal scrollbar will always be visible.',
			'The horizontal scrollbar will always be hidden.'
		],
		description: 'การแสดงแถบเลื่อนแนวนอน (Controls the visibility of the horizontal scrollbar.)'
	},
	{
		id: 'editor.scrollbar.horizontalScrollbarSize',
		group: 'Text Editor',
		type: 'number',
		default: 12,
		description: 'ความสูงของแถบเลื่อนแนวนอน (The height of the horizontal scrollbar.)'
	},
	{
		id: 'editor.scrollbar.ignoreHorizontalScrollbarInContentHeight',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ไม่นับแถบเลื่อนแนวนอนในความสูงของเนื้อหา (When set, the horizontal scrollbar will not increase the size of the editor\'s content.)'
	},
	{
		id: 'editor.scrollbar.scrollByPage',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'คลิกที่แถบเลื่อนแล้วเลื่อนทีละหน้าแทนการกระโดดไปตำแหน่งที่คลิก (Controls whether clicks scroll by page or jump to click position.)'
	},
	{
		id: 'editor.scrollbar.vertical',
		group: 'Text Editor',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'visible', 'hidden'],
		enumDescriptions: [
			'The vertical scrollbar will be visible only when necessary.',
			'The vertical scrollbar will always be visible.',
			'The vertical scrollbar will always be hidden.'
		],
		description: 'การแสดงแถบเลื่อนแนวตั้ง (Controls the visibility of the vertical scrollbar.)'
	},
	{
		id: 'editor.scrollbar.verticalScrollbarSize',
		group: 'Text Editor',
		type: 'number',
		default: 14,
		description: 'ความกว้างของแถบเลื่อนแนวตั้ง (The width of the vertical scrollbar.)'
	},
	{
		id: 'editor.scrollBeyondLastColumn',
		group: 'Text Editor',
		type: 'number',
		default: 4,
		minimum: 0,
		maximum: 1073741824,
		integer: true,
		description: 'จำนวนอักขระที่เลื่อนแนวนอนเลยคอลัมน์สุดท้ายได้ (Controls the number of extra characters beyond which the editor will scroll horizontally.)'
	},
	{
		id: 'editor.scrollBeyondLastLine',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เลื่อนเลยบรรทัดสุดท้ายได้ (Controls whether the editor will scroll beyond the last line.)'
	},
	{
		id: 'editor.scrollOnMiddleClick',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'เลื่อน editor ด้วยการกดปุ่มกลางของเมาส์ (Controls whether the editor will scroll when the middle button is pressed.)'
	},
	{
		id: 'editor.scrollPredominantAxis',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เลื่อนตามแกนหลักเท่านั้นเมื่อเลื่อนทั้งแนวตั้งและแนวนอนพร้อมกัน (Scroll only along the predominant axis when scrolling both vertically and horizontally at the same time. Prevents horizontal drift when scrolling vertically on a trackpad.)'
	},
	{
		id: 'editor.selectionClipboard',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'รองรับคลิปบอร์ด primary ของ Linux (Controls whether the Linux primary clipboard should be supported.)'
	},
	{
		id: 'editor.selectionHighlight',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ไฮไลต์ข้อความที่ตรงกับส่วนที่เลือก (Controls whether the editor should highlight matches similar to the selection.)'
	},
	{
		id: 'editor.selectionHighlightMaxLength',
		group: 'Text Editor',
		type: 'number',
		default: 200,
		minimum: 0,
		maximum: 1073741824,
		integer: true,
		description: 'จำนวนอักขระสูงสุดของข้อความที่เลือกที่จะไฮไลต์คำที่ตรงกัน 0 คือไม่จำกัด (Controls how many characters can be in the selection before similar matches are not highlighted. Set to zero for unlimited.)'
	},
	{
		id: 'editor.selectionHighlightMultiline',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ไฮไลต์ผลที่ตรงกับข้อความที่เลือกแม้คร่อมหลายบรรทัด (Controls whether the editor should highlight selection matches that span multiple lines.)'
	},
	{
		id: 'editor.semanticHighlighting.enabled',
		group: 'Text Editor',
		type: 'json',
		schema: { enum: [true, false, 'configuredByTheme'] },
		default: 'configuredByTheme',
		description: 'ใช้สีจาก semantic token ของ language server (Controls whether the semanticHighlighting is shown for the languages that support it.)'
	},
	{
		id: 'editor.showDeprecated',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ขีดฆ่าชื่อที่เลิกใช้แล้ว (Controls strikethrough deprecated variables.)'
	},
	{
		id: 'editor.showFoldingControls',
		group: 'Text Editor',
		type: 'string',
		default: 'mouseover',
		enum: ['always', 'never', 'mouseover'],
		enumDescriptions: [
			'Always show the folding controls.',
			'Never show the folding controls and reduce the gutter size.',
			'Only show the folding controls when the mouse is over the gutter.'
		],
		description: 'เมื่อใดที่แสดงปุ่มพับโค้ดที่ขอบซ้าย (Controls when the folding controls on the gutter are shown.)'
	},
	{
		id: 'editor.showUnused',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ทำให้โค้ดที่ไม่ได้ใช้จางลง (Controls fading out of unused code.)'
	},
	{
		id: 'editor.smartSelect.selectLeadingAndTrailingWhitespace',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เลือกช่องว่างนำหน้าและต่อท้ายเสมอ (Whether leading and trailing whitespace should always be selected.)'
	},
	{
		id: 'editor.smartSelect.selectSubwords',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เลือกคำย่อย เช่น foo ใน fooBar หรือ foo_bar (Whether subwords (like \'foo\' in \'fooBar\' or \'foo_bar\') should be selected.)'
	},
	{
		id: 'editor.smoothScrolling',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'เลื่อนแบบมีแอนิเมชัน (Controls whether the editor will scroll using an animation.)'
	},
	{
		id: 'editor.snippetSuggestions',
		group: 'Text Editor',
		type: 'string',
		default: 'inline',
		enum: ['top', 'bottom', 'inline', 'none'],
		enumDescriptions: [
			'Show snippet suggestions on top of other suggestions.',
			'Show snippet suggestions below other suggestions.',
			'Show snippets suggestions with other suggestions.',
			'Do not show snippet suggestions.'
		],
		description: 'ตำแหน่งของ snippet ในรายการคำแนะนำ (Controls whether snippets are shown with other suggestions and how they are sorted.)'
	},
	{
		id: 'editor.stablePeek',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ให้หน้าต่าง peek เปิดค้างแม้ดับเบิลคลิกเนื้อหาหรือกด Escape (Keep peek editors open even when double-clicking their content or when hitting `Escape`.)'
	},
	{
		id: 'editor.stickyScroll.defaultModel',
		group: 'Text Editor',
		type: 'string',
		default: 'outlineModel',
		enum: ['outlineModel', 'foldingProviderModel', 'indentationModel'],
		description: 'แบบจำลองที่ใช้เลือกบรรทัดที่ติดอยู่ด้านบน (Defines the model to use for determining which lines to stick. If the outline model does not exist, it will fall back on the folding provider model which falls back on the indentation model. This order is respected in all three cases.)'
	},
	{
		id: 'editor.stickyScroll.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ตรึงหัวของ scope ที่ซ้อนกันไว้ด้านบนขณะเลื่อน (Shows the nested current scopes during the scroll at the top of the editor.)'
	},
	{
		id: 'editor.stickyScroll.maxLineCount',
		group: 'Text Editor',
		type: 'number',
		default: 5,
		minimum: 1,
		maximum: 20,
		description: 'จำนวนบรรทัดที่ติดด้านบนสูงสุด (Defines the maximum number of sticky lines to show.)'
	},
	{
		id: 'editor.stickyScroll.scrollWithEditor',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ให้บรรทัดที่ติดด้านบนเลื่อนแนวนอนตาม editor (Enable scrolling of Sticky Scroll with the editor\'s horizontal scrollbar.)'
	},
	{
		id: 'editor.stickyTabStops',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จำลองการเลือกแบบแท็บเมื่อย่อหน้าด้วยช่องว่าง (Emulate selection behavior of tab characters when using spaces for indentation. Selection will stick to tab stops.)'
	},
	{
		id: 'editor.suggest.filterGraceful',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'กรองและเรียงคำแนะนำโดยยอมให้พิมพ์ผิดเล็กน้อย (Controls whether filtering and sorting suggestions accounts for small typos.)'
	},
	{
		id: 'editor.suggest.insertMode',
		group: 'Text Editor',
		type: 'string',
		default: 'insert',
		enum: ['insert', 'replace'],
		enumDescriptions: [
			'Insert suggestion without overwriting text right of the cursor.',
			'Insert suggestion and overwrite text right of the cursor.'
		],
		description: 'เขียนทับคำเมื่อยอมรับคำแนะนำหรือไม่ (Controls whether words are overwritten when accepting completions. Note that this depends on extensions opting into this feature.)'
	},
	{
		id: 'editor.suggest.localityBonus',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ให้คำที่อยู่ใกล้เคอร์เซอร์อยู่ลำดับต้น (Controls whether sorting favors words that appear close to the cursor.)'
	},
	{
		id: 'editor.suggest.matchOnWordStartOnly',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'อักขระแรกที่พิมพ์ต้องตรงกับต้นคำเมื่อกรองคำแนะนำ (When enabled IntelliSense filtering requires that the first character matches on a word start. For example, `c` on `Console` or `WebContext` but _not_ on `description`. When disabled IntelliSense will show more results but still sorts them by match quality.)'
	},
	{
		id: 'editor.suggest.preview',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'แสดงตัวอย่างผลของคำแนะนำใน editor (Controls whether to preview the suggestion outcome in the editor.)'
	},
	{
		id: 'editor.suggest.selectionMode',
		group: 'Text Editor',
		type: 'string',
		default: 'always',
		enum: ['always', 'never', 'whenTriggerCharacter', 'whenQuickSuggestion'],
		enumDescriptions: [
			'Always select a suggestion when automatically triggering IntelliSense.',
			'Never select a suggestion when automatically triggering IntelliSense.',
			'Select a suggestion only when triggering IntelliSense from a trigger character.',
			'Select a suggestion only when triggering IntelliSense as you type.'
		],
		description: 'เลือกคำแนะนำแรกไว้ให้เมื่อรายการแสดงหรือไม่ (Controls whether a suggestion is selected when the widget shows. Note that this only applies to automatically triggered suggestions (`#editor.quickSuggestions#` and `#editor.suggestOnTriggerCharacters#`) and that a suggestion is always selected when explicitly invoked, e.g via `Ctrl+Space`.)'
	},
	{
		id: 'editor.suggest.showClasses',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท class (When enabled IntelliSense shows `class`-suggestions.)'
	},
	{
		id: 'editor.suggest.showColors',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท color (When enabled IntelliSense shows `color`-suggestions.)'
	},
	{
		id: 'editor.suggest.showConstants',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท constant (When enabled IntelliSense shows `constant`-suggestions.)'
	},
	{
		id: 'editor.suggest.showConstructors',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท constructor (When enabled IntelliSense shows `constructor`-suggestions.)'
	},
	{
		id: 'editor.suggest.showDeprecated',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำที่เลิกใช้แล้ว (When enabled IntelliSense shows `deprecated`-suggestions.)'
	},
	{
		id: 'editor.suggest.showEnumMembers',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท enumMember (When enabled IntelliSense shows `enumMember`-suggestions.)'
	},
	{
		id: 'editor.suggest.showEnums',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท enum (When enabled IntelliSense shows `enum`-suggestions.)'
	},
	{
		id: 'editor.suggest.showEvents',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท event (When enabled IntelliSense shows `event`-suggestions.)'
	},
	{
		id: 'editor.suggest.showFields',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท field (When enabled IntelliSense shows `field`-suggestions.)'
	},
	{
		id: 'editor.suggest.showFiles',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท file (When enabled IntelliSense shows `file`-suggestions.)'
	},
	{
		id: 'editor.suggest.showFolders',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท folder (When enabled IntelliSense shows `folder`-suggestions.)'
	},
	{
		id: 'editor.suggest.showFunctions',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท function (When enabled IntelliSense shows `function`-suggestions.)'
	},
	{
		id: 'editor.suggest.showIcons',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงไอคอนในรายการคำแนะนำ (Controls whether to show or hide icons in suggestions.)'
	},
	{
		id: 'editor.suggest.showInlineDetails',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงรายละเอียดคำแนะนำต่อท้ายชื่อในรายการ (Controls whether suggest details show inline with the label or only in the details widget.)'
	},
	{
		id: 'editor.suggest.showInterfaces',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท interface (When enabled IntelliSense shows `interface`-suggestions.)'
	},
	{
		id: 'editor.suggest.showIssues',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท issues (When enabled IntelliSense shows `issues`-suggestions.)'
	},
	{
		id: 'editor.suggest.showKeywords',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท keyword (When enabled IntelliSense shows `keyword`-suggestions.)'
	},
	{
		id: 'editor.suggest.showMethods',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท method (When enabled IntelliSense shows `method`-suggestions.)'
	},
	{
		id: 'editor.suggest.showModules',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท module (When enabled IntelliSense shows `module`-suggestions.)'
	},
	{
		id: 'editor.suggest.showOperators',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท operator (When enabled IntelliSense shows `operator`-suggestions.)'
	},
	{
		id: 'editor.suggest.showProperties',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท property (When enabled IntelliSense shows `property`-suggestions.)'
	},
	{
		id: 'editor.suggest.showReferences',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท reference (When enabled IntelliSense shows `reference`-suggestions.)'
	},
	{
		id: 'editor.suggest.showSnippets',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท snippet (When enabled IntelliSense shows `snippet`-suggestions.)'
	},
	{
		id: 'editor.suggest.showStatusBar',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'แสดงแถบสถานะท้ายรายการคำแนะนำ (Controls the visibility of the status bar at the bottom of the suggest widget.)'
	},
	{
		id: 'editor.suggest.showStructs',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท struct (When enabled IntelliSense shows `struct`-suggestions.)'
	},
	{
		id: 'editor.suggest.showTypeParameters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท typeParameter (When enabled IntelliSense shows `typeParameter`-suggestions.)'
	},
	{
		id: 'editor.suggest.showUnits',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท unit (When enabled IntelliSense shows `unit`-suggestions.)'
	},
	{
		id: 'editor.suggest.showUsers',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท user (When enabled IntelliSense shows `user`-suggestions.)'
	},
	{
		id: 'editor.suggest.showValues',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท value (When enabled IntelliSense shows `value`-suggestions.)'
	},
	{
		id: 'editor.suggest.showVariables',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภท variable (When enabled IntelliSense shows `variable`-suggestions.)'
	},
	{
		id: 'editor.suggest.showWords',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำประเภทข้อความ (When enabled IntelliSense shows `text`-suggestions.)'
	},
	{
		id: 'editor.suggest.snippetsPreventQuickSuggestions',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ไม่แสดงคำแนะนำอัตโนมัติขณะอยู่ใน snippet (Controls whether an active snippet prevents quick suggestions.)'
	},
	{
		id: 'editor.suggestFontSize',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 1000,
		integer: true,
		description: 'ขนาดตัวอักษรของรายการคำแนะนำ 0 คือใช้ editor.fontSize (Font size for the suggest widget. When set to `0`, the value of `#editor.fontSize#` is used.)'
	},
	{
		id: 'editor.suggestLineHeight',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 1000,
		integer: true,
		description: 'ความสูงบรรทัดของรายการคำแนะนำ 0 คือใช้ editor.lineHeight (Line height for the suggest widget. When set to `0`, the value of `#editor.lineHeight#` is used. The minimum value is 8.)'
	},
	{
		id: 'editor.suggestOnTriggerCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำเมื่อพิมพ์อักขระกระตุ้น เช่น . (Controls whether suggestions should automatically show up when typing trigger characters.)'
	},
	{
		id: 'editor.suggestSelection',
		group: 'Text Editor',
		type: 'string',
		default: 'first',
		enum: ['first', 'recentlyUsed', 'recentlyUsedByPrefix'],
		enumDescriptions: [
			'Always select the first suggestion.',
			'Select recent suggestions unless further typing selects one, e.g. `console.| -> console.log` because `log` has been completed recently.',
			'Select suggestions based on previous prefixes that have completed those suggestions, e.g. `co -> console` and `con -> const`.'
		],
		description: 'วิธีเลือกคำแนะนำไว้ล่วงหน้าเมื่อแสดงรายการ (Controls how suggestions are pre-selected when showing the suggest list.)'
	},
	{
		id: 'editor.tabCompletion',
		group: 'Text Editor',
		type: 'string',
		default: 'off',
		enum: ['on', 'off', 'onlySnippets'],
		enumDescriptions: [
			'Tab complete will insert the best matching suggestion when pressing tab.',
			'Disable tab completions.',
			'Tab complete snippets when their prefix match. Works best when \'quickSuggestions\' aren\'t enabled.'
		],
		description: 'เติมคำด้วย Tab (Enables tab completions.)'
	},
	{
		id: 'editor.tabFocusMode',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ให้ปุ่ม Tab ย้ายโฟกัสออกจาก editor แทนการแทรกแท็บ (Controls whether the editor receives tabs or defers them to the workbench for navigation.)'
	},
	{
		id: 'editor.trimAutoWhitespace',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ลบช่องว่างท้ายบรรทัดที่ editor แทรกให้อัตโนมัติ (Remove trailing auto inserted whitespace.)'
	},
	{
		id: 'editor.trimWhitespaceOnDelete',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ลบช่องว่างย่อหน้าของบรรทัดถัดไปด้วยเมื่อลบการขึ้นบรรทัด (Controls whether the editor will also delete the next line\'s indentation whitespace when deleting a newline.)'
	},
	{
		id: 'editor.unfoldOnClickAfterEndOfLine',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'คลิกพื้นที่ว่างหลังบรรทัดที่พับไว้เพื่อคลายการพับ (Controls whether clicking on the empty content after a folded line will unfold the line.)'
	},
	{
		id: 'editor.unicodeHighlight.allowedCharacters',
		group: 'Text Editor',
		type: 'object',
		values: 'boolean',
		default: {},
		description: 'อักขระที่อนุญาตและไม่ต้องไฮไลต์ (Defines allowed characters that are not being highlighted.)',
		scope: 'application'
	},
	{
		id: 'editor.unicodeHighlight.allowedLocales',
		group: 'Text Editor',
		type: 'object',
		values: 'boolean',
		default: { _os: true, _vscode: true },
		description: 'อักขระที่ใช้ทั่วไปใน locale ที่อนุญาตจะไม่ถูกไฮไลต์ (Unicode characters that are common in allowed locales are not being highlighted.)',
		scope: 'application'
	},
	{
		id: 'editor.unicodeHighlight.ambiguousCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ไฮไลต์อักขระที่หน้าตาคล้ายอักขระ ASCII พื้นฐาน (Controls whether characters are highlighted that can be confused with basic ASCII characters, except those that are common in the current user locale.)',
		scope: 'application'
	},
	{
		id: 'editor.unicodeHighlight.includeComments',
		group: 'Text Editor',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, false, 'inUntrustedWorkspace'] },
		default: 'inUntrustedWorkspace',
		description: 'ไฮไลต์อักขระ Unicode ใน comment ด้วย (Controls whether characters in comments should also be subject to Unicode highlighting.)',
		scope: 'application'
	},
	{
		id: 'editor.unicodeHighlight.includeStrings',
		group: 'Text Editor',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, false, 'inUntrustedWorkspace'] },
		default: true,
		description: 'ไฮไลต์อักขระ Unicode ในสตริงด้วย (Controls whether characters in strings should also be subject to Unicode highlighting.)',
		scope: 'application'
	},
	{
		id: 'editor.unicodeHighlight.invisibleCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ไฮไลต์อักขระที่มองไม่เห็นหรือไม่มีความกว้าง (Controls whether characters that just reserve space or have no width at all are highlighted.)',
		scope: 'application'
	},
	{
		id: 'editor.unicodeHighlight.nonBasicASCII',
		group: 'Text Editor',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, false, 'inUntrustedWorkspace'] },
		default: 'inUntrustedWorkspace',
		description: 'ไฮไลต์อักขระทุกตัวที่ไม่ใช่ ASCII พื้นฐาน (Controls whether all non-basic ASCII characters are highlighted. Only characters between U+0020 and U+007E, tab, line-feed and carriage-return are considered basic ASCII.)',
		scope: 'application'
	},
	{
		id: 'editor.unusualLineTerminators',
		group: 'Text Editor',
		type: 'string',
		default: 'prompt',
		enum: ['auto', 'off', 'prompt'],
		enumDescriptions: [
			'Unusual line terminators are automatically removed.',
			'Unusual line terminators are ignored.',
			'Unusual line terminators prompt to be removed.'
		],
		description: 'ลบตัวจบบรรทัดแปลก ๆ ที่อาจทำให้เกิดปัญหา (Remove unusual line terminators that might cause problems.)'
	},
	{
		id: 'editor.useTabStops',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แทรกและลบช่องว่างตามตำแหน่งแท็บ (Spaces and tabs are inserted and deleted in alignment with tab stops.)'
	},
	{
		id: 'editor.wordBasedSuggestions',
		group: 'Text Editor',
		type: 'string',
		default: 'offWithInlineSuggestions',
		enum: ['off', 'offWithInlineSuggestions', 'currentDocument', 'matchingDocuments', 'allDocuments'],
		enumDescriptions: [
			'Turn off Word Based Suggestions.',
			'Turn off Word Based Suggestions when Inline Suggestions are present.',
			'Only suggest words from the active document.',
			'Suggest words from all open documents of the same language.',
			'Suggest words from all open documents.'
		],
		description: 'แนะนำคำจากเนื้อหาในเอกสาร (Controls whether completions should be computed based on words in the document and from which documents they are computed.)'
	},
	{
		id: 'editor.wordBreak',
		group: 'Text Editor',
		type: 'string',
		default: 'normal',
		enum: ['normal', 'keepAll'],
		enumDescriptions: [
			'Use the default line break rule.',
			'Word breaks should not be used for Chinese/Japanese/Korean (CJK) text. Non-CJK text behavior is the same as for normal.'
		],
		description: 'กฎการตัดคำของข้อความจีน ญี่ปุ่น เกาหลี (Controls the word break rules used for Chinese/Japanese/Korean (CJK) text.)'
	},
	{
		id: 'editor.wordSegmenterLocales',
		group: 'Text Editor',
		type: 'array',
		items: 'string',
		default: [],
		description: 'locale ที่ใช้แบ่งคำเมื่อเลื่อนหรือทำงานทีละคำ เช่น th สำหรับภาษาไทย (Locales to be used for word segmentation when doing word related navigations or operations. Specify the BCP 47 language tag of the word you wish to recognize (e.g., ja, zh-CN, zh-Hant-TW, etc.).)'
	},
	{
		id: 'editor.wordSeparators',
		group: 'Text Editor',
		type: 'string',
		default: '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?',
		description: 'อักขระที่ใช้แบ่งคำเมื่อเลื่อนหรือทำงานทีละคำ (Characters that will be used as word separators when doing word related navigations or operations.)'
	},
	{
		id: 'editor.wordWrapColumn',
		group: 'Text Editor',
		type: 'number',
		default: 80,
		minimum: 1,
		maximum: 1073741824,
		integer: true,
		description: 'คอลัมน์ที่ตัดบรรทัด เมื่อ editor.wordWrap เป็น wordWrapColumn หรือ bounded (Controls the wrapping column of the editor when `#editor.wordWrap#` is `wordWrapColumn` or `bounded`.)'
	},
	{
		id: 'editor.wordWrapIndicator',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'แสดงสัญลักษณ์ที่คอลัมน์ตัดบรรทัดของบรรทัดที่ถูกตัด (Controls whether an indicator is rendered at the wrapping column of lines that wrap. Only has an effect when `#editor.wordWrap#` is enabled.)'
	},
	{
		id: 'editor.wrapOnEscapedLineFeeds',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ตัดบรรทัดที่ข้อความ \\n ในสตริงเมื่อเปิด wordWrap (Controls whether literal `\\n` shall trigger a wordWrap when `#editor.wordWrap#` is enabled.\n\nFor example:\n```c\nchar* str="hello\\nworld"\n```\nwill be displayed as\n```c\nchar* str="hello\\n\n           world"\n```)'
	},
	{
		id: 'editor.wrappingIndent',
		group: 'Text Editor',
		type: 'string',
		default: 'same',
		enum: ['none', 'same', 'indent', 'deepIndent'],
		enumDescriptions: [
			'No indentation. Wrapped lines begin at column 1.',
			'Wrapped lines get the same indentation as the parent.',
			'Wrapped lines get +1 indentation toward the parent.',
			'Wrapped lines get +2 indentation toward the parent.'
		],
		description: 'การย่อหน้าของบรรทัดที่ถูกตัด (Controls the indentation of wrapped lines.)'
	},
	{
		id: 'editor.wrappingStrategy',
		group: 'Text Editor',
		type: 'string',
		default: 'simple',
		enum: ['simple', 'advanced'],
		enumDescriptions: [
			'Assumes that all characters are of the same width. This is a fast algorithm that works correctly for monospace fonts and certain scripts (like Latin characters) where glyphs are of equal width.',
			'Delegates wrapping points computation to the browser. This is a slow algorithm, that might cause freezes for large files, but it works correctly in all cases.'
		],
		description: 'อัลกอริทึมที่ใช้คำนวณจุดตัดบรรทัด (Controls the algorithm that computes wrapping points. Note that when in accessibility mode, advanced will be used for the best experience.)'
	}
];
