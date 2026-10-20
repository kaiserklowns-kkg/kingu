// VS Code settings: css.*, scss.*, less.* (vscode-css-language-server). Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const CSS_SETTINGS: SettingSchema[] = [
	{
		id: 'css.validate',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'ตรวจความถูกต้องทั้งหมด ของ CSS (Enables or disables all validations.)'
	},
	{
		id: 'css.completion.triggerPropertyValueCompletion',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แนะนำค่าต่อทันทีหลังเลือก property ของ CSS (By default, Kingu triggers property value completion after selecting a CSS property. Use this setting to disable this behavior.)'
	},
	{
		id: 'css.completion.completePropertyWithSemicolon',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เติมเซมิโคลอนเมื่อเติม property ของ CSS (Insert semicolon at end of line when completing CSS properties.)'
	},
	{
		id: 'css.hover.documentation',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แสดงคำอธิบายใน hover ของ CSS (Show property and value documentation in CSS hovers.)'
	},
	{
		id: 'css.hover.references',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แสดงลิงก์อ้างอิง MDN ใน hover ของ CSS (Show references to MDN in CSS hovers.)'
	},
	{
		id: 'css.format.enable',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เปิดตัวจัดรูปแบบ ของ CSS (Enable/disable default CSS formatter.)'
	},
	{
		id: 'css.format.newlineBetweenSelectors',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แยก selector ด้วยบรรทัดใหม่ ของ CSS (Separate selectors with a new line.)'
	},
	{
		id: 'css.format.newlineBetweenRules',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เว้นบรรทัดว่างระหว่าง rule ของ CSS (Separate rulesets by a blank line.)'
	},
	{
		id: 'css.format.spaceAroundSelectorSeparator',
		group: 'CSS',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรครอบตัวคั่น selector ของ CSS (Ensure a space character around selector separators `>`, `+`, `~` (e.g. `a > b`).)'
	},
	{
		id: 'css.format.braceStyle',
		group: 'CSS',
		type: 'string',
		default: 'collapse',
		enum: ['collapse', 'expand'],
		enumDescriptions: ['บรรทัดเดียวกับ selector', 'บรรทัดใหม่'],
		description: 'ตำแหน่งวงเล็บปีกกา ของ CSS (Put braces on the same line as rules (`collapse`) or put braces on own line (`expand`).)'
	},
	{
		id: 'css.format.preserveNewLines',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'คงบรรทัดว่างที่มีอยู่ ของ CSS (Whether existing line breaks before rules and declarations should be preserved.)'
	},
	{
		id: 'css.format.maxPreserveNewLines',
		group: 'CSS',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: null,
		description: 'จำนวนบรรทัดว่างสูงสุดที่คงไว้ ของ CSS (Maximum number of line breaks to be preserved in one chunk, when `#css.format.preserveNewLines#` is enabled.)'
	},
	{
		id: 'css.lint.compatibleVendorPrefixes',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'เมื่อใช้ vendor prefix ให้ใส่ prefix ของ browser อื่นด้วย ของ CSS (When using a vendor-specific prefix make sure to also include all other vendor-specific properties.)'
	},
	{
		id: 'css.lint.vendorPrefix',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'เมื่อใช้ vendor prefix ให้ใส่ property มาตรฐานด้วย ของ CSS (When using a vendor-specific prefix, also include the standard property.)'
	},
	{
		id: 'css.lint.duplicateProperties',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ซ้ำ ของ CSS (Do not use duplicate style definitions.)'
	},
	{
		id: 'css.lint.emptyRules',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'rule ว่าง ของ CSS (Do not use empty rulesets.)'
	},
	{
		id: 'css.lint.importStatement',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'คำสั่ง import ของ CSS (Import statements do not load in parallel.)'
	},
	{
		id: 'css.lint.boxModel',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ width หรือ height คู่กับ padding หรือ border ของ CSS (Do not use `width` or `height` when using `padding` or `border`.)'
	},
	{
		id: 'css.lint.universalSelector',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'universal selector ของ CSS (The universal selector (`*`) is known to be slow.)'
	},
	{
		id: 'css.lint.zeroUnits',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใส่หน่วยกับเลขศูนย์ ของ CSS (No unit for zero needed.)'
	},
	{
		id: 'css.lint.fontFaceProperties',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: '@font-face ต้องมี src และ font-family ของ CSS (`@font-face` rule must define `src` and `font-family` properties.)'
	},
	{
		id: 'css.lint.hexColorLength',
		group: 'CSS',
		type: 'string',
		default: 'error',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'สี hex ต้องมี 3 4 6 หรือ 8 หลัก ของ CSS (Hex colors must consist of 3, 4, 6 or 8 hex numbers.)'
	},
	{
		id: 'css.lint.argumentsInColorFunction',
		group: 'CSS',
		type: 'string',
		default: 'error',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'จำนวนพารามิเตอร์ของฟังก์ชันสีไม่ถูกต้อง ของ CSS (Invalid number of parameters.)'
	},
	{
		id: 'css.lint.unknownProperties',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ที่ไม่รู้จัก ของ CSS (Unknown property.)'
	},
	{
		id: 'css.lint.validProperties',
		group: 'CSS',
		type: 'json',
		schema: { type: 'array', items: { type: 'string' } },
		default: [],
		description: 'property ที่ไม่ตรวจว่ารู้จักหรือไม่ ของ CSS (A list of properties that are not validated against the `unknownProperties` rule.)'
	},
	{
		id: 'css.lint.ieHack',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'IE hack ของ CSS (IE hacks are only necessary when supporting IE7 and older.)'
	},
	{
		id: 'css.lint.unknownVendorSpecificProperties',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property เฉพาะ vendor ที่ไม่รู้จัก ของ CSS (Unknown vendor specific property.)'
	},
	{
		id: 'css.lint.propertyIgnoredDueToDisplay',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ที่ไม่มีผลเพราะค่า display ของ CSS (Property is ignored due to the display. E.g. with `display: inline`, the `width`, `height`, `margin-top`, `margin-bottom`, and `float` properties have no effect.)'
	},
	{
		id: 'css.lint.important',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ !important ของ CSS (Avoid using `!important`. It is an indication that the specificity of the entire CSS has gotten out of control and needs to be refactored.)'
	},
	{
		id: 'css.lint.float',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ float ของ CSS (Avoid using `float`. Floats lead to fragile CSS that is easy to break if one aspect of the layout changes.)'
	},
	{
		id: 'css.lint.idSelector',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'selector แบบ id ของ CSS (Selectors should not contain IDs because these rules are too tightly coupled with the HTML.)'
	},
	{
		id: 'css.lint.unknownAtRules',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'at-rule ที่ไม่รู้จัก ของ CSS (Unknown at-rule.)'
	},
	{
		id: 'scss.validate',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'ตรวจความถูกต้องทั้งหมด ของ SCSS (Enables or disables all validations.)'
	},
	{
		id: 'scss.completion.triggerPropertyValueCompletion',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แนะนำค่าต่อทันทีหลังเลือก property ของ SCSS (By default, Kingu triggers property value completion after selecting a CSS property. Use this setting to disable this behavior.)'
	},
	{
		id: 'scss.completion.completePropertyWithSemicolon',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เติมเซมิโคลอนเมื่อเติม property ของ SCSS (Insert semicolon at end of line when completing CSS properties.)'
	},
	{
		id: 'scss.hover.documentation',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แสดงคำอธิบายใน hover ของ SCSS (Show property and value documentation in SCSS hovers.)'
	},
	{
		id: 'scss.hover.references',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แสดงลิงก์อ้างอิง MDN ใน hover ของ SCSS (Show references to MDN in SCSS hovers.)'
	},
	{
		id: 'scss.format.enable',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เปิดตัวจัดรูปแบบ ของ SCSS (Enable/disable default SCSS formatter.)'
	},
	{
		id: 'scss.format.newlineBetweenSelectors',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แยก selector ด้วยบรรทัดใหม่ ของ SCSS (Separate selectors with a new line.)'
	},
	{
		id: 'scss.format.newlineBetweenRules',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เว้นบรรทัดว่างระหว่าง rule ของ SCSS (Separate rulesets by a blank line.)'
	},
	{
		id: 'scss.format.spaceAroundSelectorSeparator',
		group: 'CSS',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรครอบตัวคั่น selector ของ SCSS (Ensure a space character around selector separators `>`, `+`, `~` (e.g. `a > b`).)'
	},
	{
		id: 'scss.format.braceStyle',
		group: 'CSS',
		type: 'string',
		default: 'collapse',
		enum: ['collapse', 'expand'],
		enumDescriptions: ['บรรทัดเดียวกับ selector', 'บรรทัดใหม่'],
		description: 'ตำแหน่งวงเล็บปีกกา ของ SCSS (Put braces on the same line as rules (`collapse`) or put braces on own line (`expand`).)'
	},
	{
		id: 'scss.format.preserveNewLines',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'คงบรรทัดว่างที่มีอยู่ ของ SCSS (Whether existing line breaks before rules and declarations should be preserved.)'
	},
	{
		id: 'scss.format.maxPreserveNewLines',
		group: 'CSS',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: null,
		description: 'จำนวนบรรทัดว่างสูงสุดที่คงไว้ ของ SCSS (Maximum number of line breaks to be preserved in one chunk, when `#scss.format.preserveNewLines#` is enabled.)'
	},
	{
		id: 'scss.lint.compatibleVendorPrefixes',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'เมื่อใช้ vendor prefix ให้ใส่ prefix ของ browser อื่นด้วย ของ SCSS (When using a vendor-specific prefix make sure to also include all other vendor-specific properties.)'
	},
	{
		id: 'scss.lint.vendorPrefix',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'เมื่อใช้ vendor prefix ให้ใส่ property มาตรฐานด้วย ของ SCSS (When using a vendor-specific prefix, also include the standard property.)'
	},
	{
		id: 'scss.lint.duplicateProperties',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ซ้ำ ของ SCSS (Do not use duplicate style definitions.)'
	},
	{
		id: 'scss.lint.emptyRules',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'rule ว่าง ของ SCSS (Do not use empty rulesets.)'
	},
	{
		id: 'scss.lint.importStatement',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'คำสั่ง import ของ SCSS (Import statements do not load in parallel.)'
	},
	{
		id: 'scss.lint.boxModel',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ width หรือ height คู่กับ padding หรือ border ของ SCSS (Do not use `width` or `height` when using `padding` or `border`.)'
	},
	{
		id: 'scss.lint.universalSelector',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'universal selector ของ SCSS (The universal selector (`*`) is known to be slow.)'
	},
	{
		id: 'scss.lint.zeroUnits',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใส่หน่วยกับเลขศูนย์ ของ SCSS (No unit for zero needed.)'
	},
	{
		id: 'scss.lint.fontFaceProperties',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: '@font-face ต้องมี src และ font-family ของ SCSS (`@font-face` rule must define `src` and `font-family` properties.)'
	},
	{
		id: 'scss.lint.hexColorLength',
		group: 'CSS',
		type: 'string',
		default: 'error',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'สี hex ต้องมี 3 4 6 หรือ 8 หลัก ของ SCSS (Hex colors must consist of 3, 4, 6 or 8 hex numbers.)'
	},
	{
		id: 'scss.lint.argumentsInColorFunction',
		group: 'CSS',
		type: 'string',
		default: 'error',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'จำนวนพารามิเตอร์ของฟังก์ชันสีไม่ถูกต้อง ของ SCSS (Invalid number of parameters.)'
	},
	{
		id: 'scss.lint.unknownProperties',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ที่ไม่รู้จัก ของ SCSS (Unknown property.)'
	},
	{
		id: 'scss.lint.validProperties',
		group: 'CSS',
		type: 'json',
		schema: { type: 'array', items: { type: 'string' } },
		default: [],
		description: 'property ที่ไม่ตรวจว่ารู้จักหรือไม่ ของ SCSS (A list of properties that are not validated against the `unknownProperties` rule.)'
	},
	{
		id: 'scss.lint.ieHack',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'IE hack ของ SCSS (IE hacks are only necessary when supporting IE7 and older.)'
	},
	{
		id: 'scss.lint.unknownVendorSpecificProperties',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property เฉพาะ vendor ที่ไม่รู้จัก ของ SCSS (Unknown vendor specific property.)'
	},
	{
		id: 'scss.lint.propertyIgnoredDueToDisplay',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ที่ไม่มีผลเพราะค่า display ของ SCSS (Property is ignored due to the display. E.g. with `display: inline`, the `width`, `height`, `margin-top`, `margin-bottom`, and `float` properties have no effect.)'
	},
	{
		id: 'scss.lint.important',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ !important ของ SCSS (Avoid using `!important`. It is an indication that the specificity of the entire CSS has gotten out of control and needs to be refactored.)'
	},
	{
		id: 'scss.lint.float',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ float ของ SCSS (Avoid using `float`. Floats lead to fragile CSS that is easy to break if one aspect of the layout changes.)'
	},
	{
		id: 'scss.lint.idSelector',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'selector แบบ id ของ SCSS (Selectors should not contain IDs because these rules are too tightly coupled with the HTML.)'
	},
	{
		id: 'scss.lint.unknownAtRules',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'at-rule ที่ไม่รู้จัก ของ SCSS (Unknown at-rule.)'
	},
	{
		id: 'less.validate',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'ตรวจความถูกต้องทั้งหมด ของ LESS (Enables or disables all validations.)'
	},
	{
		id: 'less.completion.triggerPropertyValueCompletion',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แนะนำค่าต่อทันทีหลังเลือก property ของ LESS (By default, Kingu triggers property value completion after selecting a CSS property. Use this setting to disable this behavior.)'
	},
	{
		id: 'less.completion.completePropertyWithSemicolon',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เติมเซมิโคลอนเมื่อเติม property ของ LESS (Insert semicolon at end of line when completing CSS properties.)'
	},
	{
		id: 'less.hover.documentation',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แสดงคำอธิบายใน hover ของ LESS (Show property and value documentation in LESS hovers.)'
	},
	{
		id: 'less.hover.references',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แสดงลิงก์อ้างอิง MDN ใน hover ของ LESS (Show references to MDN in LESS hovers.)'
	},
	{
		id: 'less.format.enable',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เปิดตัวจัดรูปแบบ ของ LESS (Enable/disable default LESS formatter.)'
	},
	{
		id: 'less.format.newlineBetweenSelectors',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'แยก selector ด้วยบรรทัดใหม่ ของ LESS (Separate selectors with a new line.)'
	},
	{
		id: 'less.format.newlineBetweenRules',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'เว้นบรรทัดว่างระหว่าง rule ของ LESS (Separate rulesets by a blank line.)'
	},
	{
		id: 'less.format.spaceAroundSelectorSeparator',
		group: 'CSS',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรครอบตัวคั่น selector ของ LESS (Ensure a space character around selector separators `>`, `+`, `~` (e.g. `a > b`).)'
	},
	{
		id: 'less.format.braceStyle',
		group: 'CSS',
		type: 'string',
		default: 'collapse',
		enum: ['collapse', 'expand'],
		enumDescriptions: ['บรรทัดเดียวกับ selector', 'บรรทัดใหม่'],
		description: 'ตำแหน่งวงเล็บปีกกา ของ LESS (Put braces on the same line as rules (`collapse`) or put braces on own line (`expand`).)'
	},
	{
		id: 'less.format.preserveNewLines',
		group: 'CSS',
		type: 'boolean',
		default: true,
		description: 'คงบรรทัดว่างที่มีอยู่ ของ LESS (Whether existing line breaks before rules and declarations should be preserved.)'
	},
	{
		id: 'less.format.maxPreserveNewLines',
		group: 'CSS',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: null,
		description: 'จำนวนบรรทัดว่างสูงสุดที่คงไว้ ของ LESS (Maximum number of line breaks to be preserved in one chunk, when `#less.format.preserveNewLines#` is enabled.)'
	},
	{
		id: 'less.lint.compatibleVendorPrefixes',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'เมื่อใช้ vendor prefix ให้ใส่ prefix ของ browser อื่นด้วย ของ LESS (When using a vendor-specific prefix make sure to also include all other vendor-specific properties.)'
	},
	{
		id: 'less.lint.vendorPrefix',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'เมื่อใช้ vendor prefix ให้ใส่ property มาตรฐานด้วย ของ LESS (When using a vendor-specific prefix, also include the standard property.)'
	},
	{
		id: 'less.lint.duplicateProperties',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ซ้ำ ของ LESS (Do not use duplicate style definitions.)'
	},
	{
		id: 'less.lint.emptyRules',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'rule ว่าง ของ LESS (Do not use empty rulesets.)'
	},
	{
		id: 'less.lint.importStatement',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'คำสั่ง import ของ LESS (Import statements do not load in parallel.)'
	},
	{
		id: 'less.lint.boxModel',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ width หรือ height คู่กับ padding หรือ border ของ LESS (Do not use `width` or `height` when using `padding` or `border`.)'
	},
	{
		id: 'less.lint.universalSelector',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'universal selector ของ LESS (The universal selector (`*`) is known to be slow.)'
	},
	{
		id: 'less.lint.zeroUnits',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใส่หน่วยกับเลขศูนย์ ของ LESS (No unit for zero needed.)'
	},
	{
		id: 'less.lint.fontFaceProperties',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: '@font-face ต้องมี src และ font-family ของ LESS (`@font-face` rule must define `src` and `font-family` properties.)'
	},
	{
		id: 'less.lint.hexColorLength',
		group: 'CSS',
		type: 'string',
		default: 'error',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'สี hex ต้องมี 3 4 6 หรือ 8 หลัก ของ LESS (Hex colors must consist of 3, 4, 6 or 8 hex numbers.)'
	},
	{
		id: 'less.lint.argumentsInColorFunction',
		group: 'CSS',
		type: 'string',
		default: 'error',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'จำนวนพารามิเตอร์ของฟังก์ชันสีไม่ถูกต้อง ของ LESS (Invalid number of parameters.)'
	},
	{
		id: 'less.lint.unknownProperties',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ที่ไม่รู้จัก ของ LESS (Unknown property.)'
	},
	{
		id: 'less.lint.validProperties',
		group: 'CSS',
		type: 'json',
		schema: { type: 'array', items: { type: 'string' } },
		default: [],
		description: 'property ที่ไม่ตรวจว่ารู้จักหรือไม่ ของ LESS (A list of properties that are not validated against the `unknownProperties` rule.)'
	},
	{
		id: 'less.lint.ieHack',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'IE hack ของ LESS (IE hacks are only necessary when supporting IE7 and older.)'
	},
	{
		id: 'less.lint.unknownVendorSpecificProperties',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property เฉพาะ vendor ที่ไม่รู้จัก ของ LESS (Unknown vendor specific property.)'
	},
	{
		id: 'less.lint.propertyIgnoredDueToDisplay',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'property ที่ไม่มีผลเพราะค่า display ของ LESS (Property is ignored due to the display. E.g. with `display: inline`, the `width`, `height`, `margin-top`, `margin-bottom`, and `float` properties have no effect.)'
	},
	{
		id: 'less.lint.important',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ !important ของ LESS (Avoid using `!important`. It is an indication that the specificity of the entire CSS has gotten out of control and needs to be refactored.)'
	},
	{
		id: 'less.lint.float',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'ใช้ float ของ LESS (Avoid using `float`. Floats lead to fragile CSS that is easy to break if one aspect of the layout changes.)'
	},
	{
		id: 'less.lint.idSelector',
		group: 'CSS',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'selector แบบ id ของ LESS (Selectors should not contain IDs because these rules are too tightly coupled with the HTML.)'
	},
	{
		id: 'less.lint.unknownAtRules',
		group: 'CSS',
		type: 'string',
		default: 'warning',
		enum: ['ignore', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'เตือน', 'ข้อผิดพลาด'],
		description: 'at-rule ที่ไม่รู้จัก ของ LESS (Unknown at-rule.)'
	},
	{
		id: 'css.trace.server',
		group: 'CSS',
		type: 'string',
		default: 'off',
		enum: ['off', 'messages', 'verbose'],
		description: 'บันทึกข้อความระหว่าง Kingu กับ CSS language server ลงช่อง Output ของ server (Traces the communication between VS Code and the CSS language server.)'
	}
];
