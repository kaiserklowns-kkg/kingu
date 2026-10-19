// VS Code settings: js/ts.*, typescript.* and javascript.* (typescript-language-server). Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const TYPESCRIPT_SETTINGS: SettingSchema[] = [
	{
		id: 'js/ts.inlayHints.parameterNames.enabled',
		group: 'TypeScript',
		type: 'string',
		default: 'none',
		enum: ['none', 'literals', 'all'],
		enumDescriptions: [
			'ไม่แสดง (Disable parameter name hints.)',
			'แสดงเฉพาะอาร์กิวเมนต์ที่เป็น literal (Enable parameter name hints only for literal arguments.)',
			'แสดงทุกอาร์กิวเมนต์ (Enable parameter name hints for literal and non-literal arguments.)'
		],
		description: 'แสดง inlay hint ชื่อพารามิเตอร์ (Enable/disable inlay hints for parameter names:\n```typescript\n\nparseInt(/* str: */ \'123\', /* radix: */ 8)\n \n```)'
	},
	{
		id: 'js/ts.inlayHints.parameterNames.suppressWhenArgumentMatchesName',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ไม่แสดง hint ชื่อพารามิเตอร์เมื่ออาร์กิวเมนต์ชื่อเดียวกับพารามิเตอร์ (Suppress parameter name hints on arguments whose text is identical to the parameter name.)'
	},
	{
		id: 'js/ts.inlayHints.parameterTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของพารามิเตอร์ที่อนุมานได้ (Enable/disable inlay hints for implicit parameter types:\n```typescript\n\nel.addEventListener(\'click\', e /* :MouseEvent */ => ...)\n \n```)'
	},
	{
		id: 'js/ts.inlayHints.variableTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของตัวแปรที่อนุมานได้ (Enable/disable inlay hints for implicit variable types:\n```typescript\n\nconst foo /* :number */ = Date.now();\n \n```)'
	},
	{
		id: 'js/ts.inlayHints.variableTypes.suppressWhenTypeMatchesName',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ไม่แสดง hint ชนิดตัวแปรเมื่อชื่อชนิดตรงกับชื่อตัวแปร (Suppress type hints on variables whose name is identical to the type name.)'
	},
	{
		id: 'js/ts.inlayHints.propertyDeclarationTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของ property ที่อนุมานได้ (Enable/disable inlay hints for implicit types on property declarations:\n```typescript\n\nclass Foo {\n	prop /* :number */ = Date.now();\n}\n \n```)'
	},
	{
		id: 'js/ts.inlayHints.functionLikeReturnTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดค่าที่ฟังก์ชันคืน (Enable/disable inlay hints for implicit return types on function signatures:\n```typescript\n\nfunction foo() /* :number */ {\n	return Date.now();\n} \n \n```)'
	},
	{
		id: 'js/ts.inlayHints.enumMemberValues.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ค่าของสมาชิก enum (Enable/disable inlay hints for member values in enum declarations:\n```typescript\n\nenum MyValue {\n	A /* = 0 */;\n	B /* = 1 */;\n}\n \n```)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterCommaDelimiter',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังเครื่องหมายจุลภาค (Defines space handling after a comma delimiter.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterConstructor',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังคำว่า constructor (Defines space handling after the constructor keyword.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterSemicolonInForStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังเซมิโคลอนในคำสั่ง for (Defines space handling after a semicolon in a for statement.)'
	},
	{
		id: 'js/ts.format.insertSpaceBeforeAndAfterBinaryOperators',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคก่อนและหลังตัวดำเนินการสองตัวถูกดำเนินการ (Defines space handling after a binary operator.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterKeywordsInControlFlowStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังคีย์เวิร์ดของคำสั่งควบคุม (Defines space handling after keywords in a control flow statement.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังคำว่า function ของฟังก์ชันนิรนาม (Defines space handling after function keyword for anonymous functions.)'
	},
	{
		id: 'js/ts.format.insertSpaceBeforeFunctionParenthesis',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคก่อนวงเล็บอาร์กิวเมนต์ของฟังก์ชัน (Defines space handling before function argument parentheses.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคในวงเล็บปีกกาว่าง (Defines space handling after opening and before closing empty braces.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังวงเล็บเปิดและก่อนวงเล็บปิดที่ไม่ว่าง (Defines space handling after opening and before closing non-empty parenthesis.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังวงเล็บเหลี่ยมเปิดและก่อนวงเล็บเหลี่ยมปิดที่ไม่ว่าง (Defines space handling after opening and before closing non-empty brackets.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังวงเล็บปีกกาเปิดและก่อนวงเล็บปีกกาปิดที่ไม่ว่าง (Defines space handling after opening and before closing non-empty braces.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคในวงเล็บของ template string (Defines space handling after opening and before closing template string braces.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคในวงเล็บของ JSX expression (Defines space handling after opening and before closing JSX expression braces.)'
	},
	{
		id: 'js/ts.format.insertSpaceAfterTypeAssertion',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลัง type assertion (Defines space handling after type assertions in TypeScript.)'
	},
	{
		id: 'js/ts.format.placeOpenBraceOnNewLineForFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ก่อนวงเล็บปีกกาเปิดของฟังก์ชัน (Defines whether an open brace is put onto a new line for functions or not.)'
	},
	{
		id: 'js/ts.format.placeOpenBraceOnNewLineForControlBlocks',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ก่อนวงเล็บปีกกาเปิดของบล็อกควบคุม (Defines whether an open brace is put onto a new line for control blocks or not.)'
	},
	{
		id: 'js/ts.format.semicolons',
		group: 'TypeScript',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'insert', 'remove'],
		enumDescriptions: [
			'ไม่เพิ่มหรือลบ (Don\'t insert or remove any semicolons.)',
			'เติมเซมิโคลอนท้ายคำสั่ง (Insert semicolons at statement ends.)',
			'ลบเซมิโคลอนที่ไม่จำเป็น (Remove unnecessary semicolons.)'
		],
		description: 'การจัดการเซมิโคลอนตอนจัดรูปแบบ (Defines handling of optional semicolons.)'
	},
	{
		id: 'js/ts.format.indentSwitchCase',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ย่อหน้า case ใน switch (Indent case clauses in switch statements. Requires using TypeScript 5.1+ in the workspace.)'
	},
	{
		id: 'js/ts.referencesCodeLens.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens จำนวนการอ้างอิง (Enable/disable references CodeLens in JavaScript and TypeScript files. This CodeLens shows the number of references for classes and exported functions and allows you to peek or navigate to them.)'
	},
	{
		id: 'js/ts.referencesCodeLens.showOnAllFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens การอ้างอิงบนทุกฟังก์ชัน (Enable/disable the [references CodeLens](#js/ts.referencesCodeLens.enabled) on all functions in JavaScript and TypeScript files.)'
	},
	{
		id: 'js/ts.implementationsCodeLens.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens จำนวน implementation (Enable/disable implementations CodeLens in TypeScript files. This CodeLens shows the implementers of TypeScript interfaces.)'
	},
	{
		id: 'js/ts.preferences.quoteStyle',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'single', 'double'],
		enumDescriptions: [
			'อนุมานจากโค้ดที่มีอยู่ (Infer quote type from existing code)',
			'ใช้ single quote (Always use single quotes: `\'`)',
			'ใช้ double quote (Always use double quotes: `"`)'
		],
		description: 'เครื่องหมายคำพูดที่ใช้ใน quick fix และ auto import (Preferred quote style to use for Quick Fixes.)'
	},
	{
		id: 'js/ts.preferences.importModuleSpecifier',
		group: 'TypeScript',
		type: 'string',
		default: 'shortest',
		enum: ['shortest', 'relative', 'non-relative', 'project-relative'],
		enumDescriptions: [
			'path ที่สั้นที่สุด (Prefers a non-relative import only if one is available that has fewer path segments than a relative import.)',
			'path สัมพัทธ์กับไฟล์ (Prefers a relative path to the imported file location.)',
			'path จาก baseUrl หรือ paths (Prefers a non-relative import based on the `baseUrl` or `paths` configured in your `jsconfig.json` / `tsconfig.json`.)',
			'สัมพัทธ์เมื่ออยู่ในโปรเจกต์เดียวกัน (Prefers a non-relative import only if the relative import path would leave the package or project directory.)'
		],
		description: 'รูปแบบ path ของ import ที่เพิ่มอัตโนมัติ (Preferred path style for auto imports.)'
	},
	{
		id: 'js/ts.preferences.importModuleSpecifierEnding',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'minimal', 'index', 'js'],
		enumDescriptions: [
			'ตาม moduleResolution (Use project settings to select a default.)',
			'ตัด /index และนามสกุล (Shorten `./component/index.js` to `./component`.)',
			'ตัดเฉพาะนามสกุล (Shorten `./component/index.js` to `./component/index`.)',
			'ใช้ .js (Do not shorten path endings; include the `.js` or `.ts` extension.)'
		],
		description: 'นามสกุลท้าย path ของ import อัตโนมัติ (Preferred path ending for auto imports.)'
	},
	{
		id: 'js/ts.preferences.jsxAttributeCompletionStyle',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'braces', 'none'],
		enumDescriptions: [
			'ตามชนิดของ attribute (Insert `={}` or `=""` after attribute names based on the prop type. See `#js/ts.preferences.quoteStyle#` to control the type of quotes used for string attributes.)',
			'ใส่วงเล็บปีกกา (Insert `={}` after attribute names.)',
			'เติมแค่ชื่อ (Only insert attribute names.)'
		],
		description: 'รูปแบบการเติม attribute ของ JSX (Preferred style for JSX attribute completions.)'
	},
	{
		id: 'js/ts.preferences.includePackageJsonAutoImports',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'on', 'off'],
		enumDescriptions: [
			'ตามจำนวน dependency (Search dependencies based on estimated performance impact.)',
			'เปิดเสมอ (Always search dependencies.)',
			'ปิด (Never search dependencies.)'
		],
		description: 'auto import จาก dependency ใน package.json (Enable/disable searching `package.json` dependencies for available auto imports.)'
	},
	{
		id: 'js/ts.preferences.preferTypeOnlyAutoImports',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ใช้ import type สำหรับ auto import ของชนิด (Include the `type` keyword in auto-imports whenever possible. Requires using TypeScript 5.3+ in the workspace.)'
	},
	{
		id: 'js/ts.preferences.autoImportFileExcludePatterns',
		group: 'TypeScript',
		type: 'array',
		items: 'string',
		default: [],
		description: 'glob ของไฟล์ที่ไม่ให้ auto import (Specify glob patterns of files to exclude from auto imports. Relative paths are resolved relative to the workspace root. Patterns are evaluated using tsconfig.json [`exclude`](https://www.typescriptlang.org/tsconfig#exclude) semantics.)'
	},
	{
		id: 'js/ts.preferences.autoImportSpecifierExcludeRegexes',
		group: 'TypeScript',
		type: 'array',
		items: 'string',
		default: [],
		description: 'regex ของ module specifier ที่ไม่ให้ auto import (Specify regular expressions to exclude auto imports with matching import specifiers. Examples:\n\n- `^node:`\n- `lib/internal` (slashes don\'t need to be escaped...)\n- `/lib\\/internal/i` (...unless including surrounding slashes for `i` or `u` flags)\n- `^lodash$` (only allow subpath imports from lodash))'
	},
	{
		id: 'js/ts.preferences.useAliasesForRenames',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ใช้ alias ตอนเปลี่ยนชื่อ property ใน shorthand (Enable/disable introducing aliases for object shorthand properties during renames.)'
	},
	{
		id: 'js/ts.suggest.autoImports',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'แนะนำ export จากไฟล์อื่นพร้อม import อัตโนมัติ (Enable/disable auto import suggestions.)'
	},
	{
		id: 'js/ts.suggest.completeFunctionCalls',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เติมวงเล็บและพารามิเตอร์เมื่อเลือกฟังก์ชัน (Complete functions with their parameter signature.)'
	},
	{
		id: 'js/ts.suggest.includeAutomaticOptionalChainCompletions',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'แนะนำสมาชิกที่ต้องใช้ optional chain (Enable/disable showing completions on potentially undefined values that insert an optional chain call. Requires strict null checks to be enabled.)'
	},
	{
		id: 'js/ts.suggest.includeCompletionsForImportStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เติมคำสั่ง import ทั้งบรรทัด (Enable/disable auto-import-style completions on partially-typed import statements.)'
	},
	{
		id: 'js/ts.suggest.classMemberSnippets.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'snippet สำหรับสมาชิกของคลาส (Enable/disable snippet completions for class members.)'
	},
	{
		id: 'js/ts.suggest.objectLiteralMethodSnippets.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'snippet สำหรับเมธอดใน object literal (Enable/disable snippet completions for methods in object literals.)'
	},
	{
		id: 'js/ts.suggest.jsdoc.generateReturns',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ใส่ @returns ใน JSDoc ที่สร้างให้ (Enable/disable generating `@returns` annotations for JSDoc templates.)'
	},
	{
		id: 'js/ts.hover.maximumLength',
		group: 'TypeScript',
		type: 'number',
		default: 500,
		description: 'ความยาวสูงสุดของข้อความ hover (The maximum number of characters in a hover. If the hover is longer than this, it will be truncated. Requires TypeScript 5.9+.)'
	},
	{
		id: 'js/ts.implicitProjectConfig.checkJs',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ตรวจชนิดในไฟล์ JavaScript ที่ไม่อยู่ในโปรเจกต์ (Enable/disable semantic checking of JavaScript files. Existing `jsconfig.json` or `tsconfig.json` files override this setting.)'
	},
	{
		id: 'js/ts.implicitProjectConfig.experimentalDecorators',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เปิด experimentalDecorators ในไฟล์ที่ไม่อยู่ในโปรเจกต์ (Enable/disable `experimentalDecorators` in JavaScript files that are not part of a project. Existing `jsconfig.json` or `tsconfig.json` files override this setting.)'
	},
	{
		id: 'js/ts.implicitProjectConfig.module',
		group: 'TypeScript',
		type: 'string',
		default: 'ESNext',
		enum: [
			'CommonJS',
			'AMD',
			'System',
			'UMD',
			'ES6',
			'ES2015',
			'ES2020',
			'ESNext',
			'None',
			'ES2022',
			'Node12',
			'NodeNext'
		],
		description: 'module ของไฟล์ที่ไม่อยู่ในโปรเจกต์ (Sets the module system for the program. See more: https://www.typescriptlang.org/tsconfig#module.)'
	},
	{
		id: 'js/ts.implicitProjectConfig.strict',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เปิด strict ในไฟล์ที่ไม่อยู่ในโปรเจกต์ (Enable/disable [strict mode](https://www.typescriptlang.org/tsconfig#strict) in JavaScript and TypeScript files that are not part of a project. Existing `jsconfig.json` or `tsconfig.json` files override this setting.)'
	},
	{
		id: 'js/ts.implicitProjectConfig.strictFunctionTypes',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เปิด strictFunctionTypes ในไฟล์ที่ไม่อยู่ในโปรเจกต์ (Enable/disable [strict function types](https://www.typescriptlang.org/tsconfig#strictFunctionTypes) in JavaScript and TypeScript files that are not part of a project. Existing `jsconfig.json` or `tsconfig.json` files override this setting.)'
	},
	{
		id: 'js/ts.implicitProjectConfig.strictNullChecks',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เปิด strictNullChecks ในไฟล์ที่ไม่อยู่ในโปรเจกต์ (Enable/disable [strict null checks](https://www.typescriptlang.org/tsconfig#strictNullChecks) in JavaScript and TypeScript files that are not part of a project. Existing `jsconfig.json` or `tsconfig.json` files override this setting.)'
	},
	{
		id: 'js/ts.implicitProjectConfig.target',
		group: 'TypeScript',
		type: 'string',
		default: 'ES2024',
		enum: [
			'ES3',
			'ES5',
			'ES6',
			'ES2015',
			'ES2016',
			'ES2017',
			'ES2018',
			'ES2019',
			'ES2020',
			'ES2021',
			'ES2022',
			'ES2023',
			'ES2024',
			'ESNext'
		],
		description: 'target ของไฟล์ที่ไม่อยู่ในโปรเจกต์ (Set target JavaScript language version for emitted JavaScript and include library declarations. See more: https://www.typescriptlang.org/tsconfig#target.)'
	},
	{
		id: 'typescript.inlayHints.parameterNames.enabled',
		group: 'TypeScript',
		type: 'string',
		default: 'none',
		enum: ['none', 'literals', 'all'],
		enumDescriptions: [
			'ไม่แสดง (Disable parameter name hints.)',
			'แสดงเฉพาะอาร์กิวเมนต์ที่เป็น literal (Enable parameter name hints only for literal arguments.)',
			'แสดงทุกอาร์กิวเมนต์ (Enable parameter name hints for literal and non-literal arguments.)'
		],
		description: 'แสดง inlay hint ชื่อพารามิเตอร์ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.parameterNames.enabled (Enable/disable inlay hints for parameter names:\n```typescript\n\nparseInt(/* str: */ \'123\', /* radix: */ 8)\n \n```)'
	},
	{
		id: 'typescript.inlayHints.parameterNames.suppressWhenArgumentMatchesName',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ไม่แสดง hint ชื่อพารามิเตอร์เมื่ออาร์กิวเมนต์ชื่อเดียวกับพารามิเตอร์ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.parameterNames.suppressWhenArgumentMatchesName (Suppress parameter name hints on arguments whose text is identical to the parameter name.)'
	},
	{
		id: 'typescript.inlayHints.parameterTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของพารามิเตอร์ที่อนุมานได้ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.parameterTypes.enabled (Enable/disable inlay hints for implicit parameter types:\n```typescript\n\nel.addEventListener(\'click\', e /* :MouseEvent */ => ...)\n \n```)'
	},
	{
		id: 'typescript.inlayHints.variableTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของตัวแปรที่อนุมานได้ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.variableTypes.enabled (Enable/disable inlay hints for implicit variable types:\n```typescript\n\nconst foo /* :number */ = Date.now();\n \n```)'
	},
	{
		id: 'typescript.inlayHints.variableTypes.suppressWhenTypeMatchesName',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ไม่แสดง hint ชนิดตัวแปรเมื่อชื่อชนิดตรงกับชื่อตัวแปร ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.variableTypes.suppressWhenTypeMatchesName (Suppress type hints on variables whose name is identical to the type name.)'
	},
	{
		id: 'typescript.inlayHints.propertyDeclarationTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของ property ที่อนุมานได้ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.propertyDeclarationTypes.enabled (Enable/disable inlay hints for implicit types on property declarations:\n```typescript\n\nclass Foo {\n	prop /* :number */ = Date.now();\n}\n \n```)'
	},
	{
		id: 'typescript.inlayHints.functionLikeReturnTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดค่าที่ฟังก์ชันคืน ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.functionLikeReturnTypes.enabled (Enable/disable inlay hints for implicit return types on function signatures:\n```typescript\n\nfunction foo() /* :number */ {\n	return Date.now();\n} \n \n```)'
	},
	{
		id: 'typescript.inlayHints.enumMemberValues.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ค่าของสมาชิก enum ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.enumMemberValues.enabled (Enable/disable inlay hints for member values in enum declarations:\n```typescript\n\nenum MyValue {\n	A /* = 0 */;\n	B /* = 1 */;\n}\n \n```)'
	},
	{
		id: 'typescript.format.insertSpaceAfterCommaDelimiter',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังเครื่องหมายจุลภาค ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterCommaDelimiter (Defines space handling after a comma delimiter.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterConstructor',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังคำว่า constructor ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterConstructor (Defines space handling after the constructor keyword.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterSemicolonInForStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังเซมิโคลอนในคำสั่ง for ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterSemicolonInForStatements (Defines space handling after a semicolon in a for statement.)'
	},
	{
		id: 'typescript.format.insertSpaceBeforeAndAfterBinaryOperators',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคก่อนและหลังตัวดำเนินการสองตัวถูกดำเนินการ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceBeforeAndAfterBinaryOperators (Defines space handling after a binary operator.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterKeywordsInControlFlowStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังคีย์เวิร์ดของคำสั่งควบคุม ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterKeywordsInControlFlowStatements (Defines space handling after keywords in a control flow statement.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังคำว่า function ของฟังก์ชันนิรนาม ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions (Defines space handling after function keyword for anonymous functions.)'
	},
	{
		id: 'typescript.format.insertSpaceBeforeFunctionParenthesis',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคก่อนวงเล็บอาร์กิวเมนต์ของฟังก์ชัน ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceBeforeFunctionParenthesis (Defines space handling before function argument parentheses.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคในวงเล็บปีกกาว่าง ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces (Defines space handling after opening and before closing empty braces.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังวงเล็บเปิดและก่อนวงเล็บปิดที่ไม่ว่าง ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis (Defines space handling after opening and before closing non-empty parenthesis.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังวงเล็บเหลี่ยมเปิดและก่อนวงเล็บเหลี่ยมปิดที่ไม่ว่าง ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets (Defines space handling after opening and before closing non-empty brackets.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังวงเล็บปีกกาเปิดและก่อนวงเล็บปีกกาปิดที่ไม่ว่าง ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces (Defines space handling after opening and before closing non-empty braces.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคในวงเล็บของ template string ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces (Defines space handling after opening and before closing template string braces.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคในวงเล็บของ JSX expression ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces (Defines space handling after opening and before closing JSX expression braces.)'
	},
	{
		id: 'typescript.format.insertSpaceAfterTypeAssertion',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลัง type assertion ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterTypeAssertion (Defines space handling after type assertions in TypeScript.)'
	},
	{
		id: 'typescript.format.placeOpenBraceOnNewLineForFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ก่อนวงเล็บปีกกาเปิดของฟังก์ชัน ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.placeOpenBraceOnNewLineForFunctions (Defines whether an open brace is put onto a new line for functions or not.)'
	},
	{
		id: 'typescript.format.placeOpenBraceOnNewLineForControlBlocks',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ก่อนวงเล็บปีกกาเปิดของบล็อกควบคุม ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.placeOpenBraceOnNewLineForControlBlocks (Defines whether an open brace is put onto a new line for control blocks or not.)'
	},
	{
		id: 'typescript.format.semicolons',
		group: 'TypeScript',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'insert', 'remove'],
		enumDescriptions: [
			'ไม่เพิ่มหรือลบ (Don\'t insert or remove any semicolons.)',
			'เติมเซมิโคลอนท้ายคำสั่ง (Insert semicolons at statement ends.)',
			'ลบเซมิโคลอนที่ไม่จำเป็น (Remove unnecessary semicolons.)'
		],
		description: 'การจัดการเซมิโคลอนตอนจัดรูปแบบ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.semicolons (Defines handling of optional semicolons.)'
	},
	{
		id: 'typescript.format.indentSwitchCase',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ย่อหน้า case ใน switch ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.indentSwitchCase (Indent case clauses in switch statements. Requires using TypeScript 5.1+ in the workspace.)'
	},
	{
		id: 'typescript.referencesCodeLens.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens จำนวนการอ้างอิง ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.referencesCodeLens.enabled (Enable/disable references CodeLens in JavaScript and TypeScript files. This CodeLens shows the number of references for classes and exported functions and allows you to peek or navigate to them.)'
	},
	{
		id: 'typescript.referencesCodeLens.showOnAllFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens การอ้างอิงบนทุกฟังก์ชัน ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.referencesCodeLens.showOnAllFunctions (Enable/disable the [references CodeLens](#js/ts.referencesCodeLens.enabled) on all functions in JavaScript and TypeScript files.)'
	},
	{
		id: 'typescript.implementationsCodeLens.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens จำนวน implementation ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.implementationsCodeLens.enabled (Enable/disable implementations CodeLens in TypeScript files. This CodeLens shows the implementers of TypeScript interfaces.)'
	},
	{
		id: 'typescript.preferences.quoteStyle',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'single', 'double'],
		enumDescriptions: [
			'อนุมานจากโค้ดที่มีอยู่ (Infer quote type from existing code)',
			'ใช้ single quote (Always use single quotes: `\'`)',
			'ใช้ double quote (Always use double quotes: `"`)'
		],
		description: 'เครื่องหมายคำพูดที่ใช้ใน quick fix และ auto import ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.quoteStyle (Preferred quote style to use for Quick Fixes.)'
	},
	{
		id: 'typescript.preferences.importModuleSpecifier',
		group: 'TypeScript',
		type: 'string',
		default: 'shortest',
		enum: ['shortest', 'relative', 'non-relative', 'project-relative'],
		enumDescriptions: [
			'path ที่สั้นที่สุด (Prefers a non-relative import only if one is available that has fewer path segments than a relative import.)',
			'path สัมพัทธ์กับไฟล์ (Prefers a relative path to the imported file location.)',
			'path จาก baseUrl หรือ paths (Prefers a non-relative import based on the `baseUrl` or `paths` configured in your `jsconfig.json` / `tsconfig.json`.)',
			'สัมพัทธ์เมื่ออยู่ในโปรเจกต์เดียวกัน (Prefers a non-relative import only if the relative import path would leave the package or project directory.)'
		],
		description: 'รูปแบบ path ของ import ที่เพิ่มอัตโนมัติ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.importModuleSpecifier (Preferred path style for auto imports.)'
	},
	{
		id: 'typescript.preferences.importModuleSpecifierEnding',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'minimal', 'index', 'js'],
		enumDescriptions: [
			'ตาม moduleResolution (Use project settings to select a default.)',
			'ตัด /index และนามสกุล (Shorten `./component/index.js` to `./component`.)',
			'ตัดเฉพาะนามสกุล (Shorten `./component/index.js` to `./component/index`.)',
			'ใช้ .js (Do not shorten path endings; include the `.js` or `.ts` extension.)'
		],
		description: 'นามสกุลท้าย path ของ import อัตโนมัติ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.importModuleSpecifierEnding (Preferred path ending for auto imports.)'
	},
	{
		id: 'typescript.preferences.jsxAttributeCompletionStyle',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'braces', 'none'],
		enumDescriptions: [
			'ตามชนิดของ attribute (Insert `={}` or `=""` after attribute names based on the prop type. See `#typescript.preferences.quoteStyle#` to control the type of quotes used for string attributes.)',
			'ใส่วงเล็บปีกกา (Insert `={}` after attribute names.)',
			'เติมแค่ชื่อ (Only insert attribute names.)'
		],
		description: 'รูปแบบการเติม attribute ของ JSX ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.jsxAttributeCompletionStyle (Preferred style for JSX attribute completions.)'
	},
	{
		id: 'typescript.preferences.includePackageJsonAutoImports',
		group: 'TypeScript',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'on', 'off'],
		enumDescriptions: [
			'ตามจำนวน dependency (Search dependencies based on estimated performance impact.)',
			'เปิดเสมอ (Always search dependencies.)',
			'ปิด (Never search dependencies.)'
		],
		description: 'auto import จาก dependency ใน package.json ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.includePackageJsonAutoImports (Enable/disable searching `package.json` dependencies for available auto imports.)'
	},
	{
		id: 'typescript.preferences.preferTypeOnlyAutoImports',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ใช้ import type สำหรับ auto import ของชนิด ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.preferTypeOnlyAutoImports (Include the `type` keyword in auto-imports whenever possible. Requires using TypeScript 5.3+ in the workspace.)'
	},
	{
		id: 'typescript.preferences.autoImportFileExcludePatterns',
		group: 'TypeScript',
		type: 'array',
		items: 'string',
		default: [],
		description: 'glob ของไฟล์ที่ไม่ให้ auto import ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.autoImportFileExcludePatterns (Specify glob patterns of files to exclude from auto imports. Relative paths are resolved relative to the workspace root. Patterns are evaluated using tsconfig.json [`exclude`](https://www.typescriptlang.org/tsconfig#exclude) semantics.)'
	},
	{
		id: 'typescript.preferences.autoImportSpecifierExcludeRegexes',
		group: 'TypeScript',
		type: 'array',
		items: 'string',
		default: [],
		description: 'regex ของ module specifier ที่ไม่ให้ auto import ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.autoImportSpecifierExcludeRegexes (Specify regular expressions to exclude auto imports with matching import specifiers. Examples:\n\n- `^node:`\n- `lib/internal` (slashes don\'t need to be escaped...)\n- `/lib\\/internal/i` (...unless including surrounding slashes for `i` or `u` flags)\n- `^lodash$` (only allow subpath imports from lodash))'
	},
	{
		id: 'typescript.preferences.useAliasesForRenames',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ใช้ alias ตอนเปลี่ยนชื่อ property ใน shorthand ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.preferences.useAliasesForRenames (Enable/disable introducing aliases for object shorthand properties during renames.)'
	},
	{
		id: 'typescript.suggest.autoImports',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'แนะนำ export จากไฟล์อื่นพร้อม import อัตโนมัติ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.suggest.autoImports (Enable/disable auto import suggestions.)'
	},
	{
		id: 'typescript.suggest.completeFunctionCalls',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เติมวงเล็บและพารามิเตอร์เมื่อเลือกฟังก์ชัน ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.suggest.completeFunctionCalls (Complete functions with their parameter signature.)'
	},
	{
		id: 'typescript.suggest.includeAutomaticOptionalChainCompletions',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'แนะนำสมาชิกที่ต้องใช้ optional chain ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.suggest.includeAutomaticOptionalChainCompletions (Enable/disable showing completions on potentially undefined values that insert an optional chain call. Requires strict null checks to be enabled.)'
	},
	{
		id: 'typescript.suggest.includeCompletionsForImportStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เติมคำสั่ง import ทั้งบรรทัด ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.suggest.includeCompletionsForImportStatements (Enable/disable auto-import-style completions on partially-typed import statements.)'
	},
	{
		id: 'typescript.suggest.classMemberSnippets.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'snippet สำหรับสมาชิกของคลาส ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.suggest.classMemberSnippets.enabled (Enable/disable snippet completions for class members.)'
	},
	{
		id: 'typescript.suggest.objectLiteralMethodSnippets.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'snippet สำหรับเมธอดใน object literal ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.suggest.objectLiteralMethodSnippets.enabled (Enable/disable snippet completions for methods in object literals.)'
	},
	{
		id: 'typescript.suggest.jsdoc.generateReturns',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ใส่ @returns ใน JSDoc ที่สร้างให้ ของ TypeScript — เลิกใช้แล้ว ให้ใช้ js/ts.suggest.jsdoc.generateReturns (Enable/disable generating `@returns` annotations for JSDoc templates.)'
	},
	{
		id: 'javascript.inlayHints.parameterNames.enabled',
		group: 'TypeScript',
		type: 'string',
		default: 'none',
		enum: ['none', 'literals', 'all'],
		enumDescriptions: [
			'ไม่แสดง (Disable parameter name hints.)',
			'แสดงเฉพาะอาร์กิวเมนต์ที่เป็น literal (Enable parameter name hints only for literal arguments.)',
			'แสดงทุกอาร์กิวเมนต์ (Enable parameter name hints for literal and non-literal arguments.)'
		],
		description: 'แสดง inlay hint ชื่อพารามิเตอร์ ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.parameterNames.enabled (Enable/disable inlay hints for parameter names:\n```typescript\n\nparseInt(/* str: */ \'123\', /* radix: */ 8)\n \n```)'
	},
	{
		id: 'javascript.inlayHints.parameterNames.suppressWhenArgumentMatchesName',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ไม่แสดง hint ชื่อพารามิเตอร์เมื่ออาร์กิวเมนต์ชื่อเดียวกับพารามิเตอร์ ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.parameterNames.suppressWhenArgumentMatchesName (Suppress parameter name hints on arguments whose text is identical to the parameter name.)'
	},
	{
		id: 'javascript.inlayHints.parameterTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของพารามิเตอร์ที่อนุมานได้ ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.parameterTypes.enabled (Enable/disable inlay hints for implicit parameter types:\n```typescript\n\nel.addEventListener(\'click\', e /* :MouseEvent */ => ...)\n \n```)'
	},
	{
		id: 'javascript.inlayHints.variableTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของตัวแปรที่อนุมานได้ ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.variableTypes.enabled (Enable/disable inlay hints for implicit variable types:\n```typescript\n\nconst foo /* :number */ = Date.now();\n \n```)'
	},
	{
		id: 'javascript.inlayHints.variableTypes.suppressWhenTypeMatchesName',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ไม่แสดง hint ชนิดตัวแปรเมื่อชื่อชนิดตรงกับชื่อตัวแปร ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.variableTypes.suppressWhenTypeMatchesName (Suppress type hints on variables whose name is identical to the type name.)'
	},
	{
		id: 'javascript.inlayHints.propertyDeclarationTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดของ property ที่อนุมานได้ ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.propertyDeclarationTypes.enabled (Enable/disable inlay hints for implicit types on property declarations:\n```typescript\n\nclass Foo {\n	prop /* :number */ = Date.now();\n}\n \n```)'
	},
	{
		id: 'javascript.inlayHints.functionLikeReturnTypes.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง inlay hint ชนิดค่าที่ฟังก์ชันคืน ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.inlayHints.functionLikeReturnTypes.enabled (Enable/disable inlay hints for implicit return types on function signatures:\n```typescript\n\nfunction foo() /* :number */ {\n	return Date.now();\n} \n \n```)'
	},
	{
		id: 'javascript.format.insertSpaceAfterCommaDelimiter',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังเครื่องหมายจุลภาค ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterCommaDelimiter (Defines space handling after a comma delimiter.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterConstructor',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังคำว่า constructor ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterConstructor (Defines space handling after the constructor keyword.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterSemicolonInForStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังเซมิโคลอนในคำสั่ง for ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterSemicolonInForStatements (Defines space handling after a semicolon in a for statement.)'
	},
	{
		id: 'javascript.format.insertSpaceBeforeAndAfterBinaryOperators',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคก่อนและหลังตัวดำเนินการสองตัวถูกดำเนินการ ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceBeforeAndAfterBinaryOperators (Defines space handling after a binary operator.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterKeywordsInControlFlowStatements',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังคีย์เวิร์ดของคำสั่งควบคุม ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterKeywordsInControlFlowStatements (Defines space handling after keywords in a control flow statement.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังคำว่า function ของฟังก์ชันนิรนาม ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterFunctionKeywordForAnonymousFunctions (Defines space handling after function keyword for anonymous functions.)'
	},
	{
		id: 'javascript.format.insertSpaceBeforeFunctionParenthesis',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคก่อนวงเล็บอาร์กิวเมนต์ของฟังก์ชัน ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceBeforeFunctionParenthesis (Defines space handling before function argument parentheses.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคในวงเล็บปีกกาว่าง ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces (Defines space handling after opening and before closing empty braces.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังวงเล็บเปิดและก่อนวงเล็บปิดที่ไม่ว่าง ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis (Defines space handling after opening and before closing non-empty parenthesis.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคหลังวงเล็บเหลี่ยมเปิดและก่อนวงเล็บเหลี่ยมปิดที่ไม่ว่าง ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets (Defines space handling after opening and before closing non-empty brackets.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'เว้นวรรคหลังวงเล็บปีกกาเปิดและก่อนวงเล็บปีกกาปิดที่ไม่ว่าง ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces (Defines space handling after opening and before closing non-empty braces.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคในวงเล็บของ template string ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces (Defines space handling after opening and before closing template string braces.)'
	},
	{
		id: 'javascript.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'เว้นวรรคในวงเล็บของ JSX expression ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces (Defines space handling after opening and before closing JSX expression braces.)'
	},
	{
		id: 'javascript.format.placeOpenBraceOnNewLineForFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ก่อนวงเล็บปีกกาเปิดของฟังก์ชัน ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.placeOpenBraceOnNewLineForFunctions (Defines whether an open brace is put onto a new line for functions or not.)'
	},
	{
		id: 'javascript.format.placeOpenBraceOnNewLineForControlBlocks',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ก่อนวงเล็บปีกกาเปิดของบล็อกควบคุม ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.placeOpenBraceOnNewLineForControlBlocks (Defines whether an open brace is put onto a new line for control blocks or not.)'
	},
	{
		id: 'javascript.format.semicolons',
		group: 'TypeScript',
		type: 'string',
		default: 'ignore',
		enum: ['ignore', 'insert', 'remove'],
		enumDescriptions: [
			'ไม่เพิ่มหรือลบ (Don\'t insert or remove any semicolons.)',
			'เติมเซมิโคลอนท้ายคำสั่ง (Insert semicolons at statement ends.)',
			'ลบเซมิโคลอนที่ไม่จำเป็น (Remove unnecessary semicolons.)'
		],
		description: 'การจัดการเซมิโคลอนตอนจัดรูปแบบ ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.semicolons (Defines handling of optional semicolons.)'
	},
	{
		id: 'javascript.format.indentSwitchCase',
		group: 'TypeScript',
		type: 'boolean',
		default: true,
		description: 'ย่อหน้า case ใน switch ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.format.indentSwitchCase (Indent case clauses in switch statements. Requires using TypeScript 5.1+ in the workspace.)'
	},
	{
		id: 'javascript.referencesCodeLens.enabled',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens จำนวนการอ้างอิง ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.referencesCodeLens.enabled (Enable/disable references CodeLens in JavaScript and TypeScript files. This CodeLens shows the number of references for classes and exported functions and allows you to peek or navigate to them.)'
	},
	{
		id: 'javascript.referencesCodeLens.showOnAllFunctions',
		group: 'TypeScript',
		type: 'boolean',
		default: false,
		description: 'แสดง CodeLens การอ้างอิงบนทุกฟังก์ชัน ของ JavaScript — เลิกใช้แล้ว ให้ใช้ js/ts.referencesCodeLens.showOnAllFunctions (Enable/disable the [references CodeLens](#js/ts.referencesCodeLens.enabled) on all functions in JavaScript and TypeScript files.)'
	}
];
