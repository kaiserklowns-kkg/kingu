// VS Code settings: outline.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const OUTLINE_SETTINGS: SettingSchema[] = [
	{
		id: 'outline.icons',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงไอคอนของรายการใน Outline (Render Outline elements with icons.)'
	},
	{
		id: 'outline.collapseItems',
		group: 'Workbench',
		type: 'string',
		default: 'alwaysExpand',
		enum: ['alwaysCollapse', 'alwaysExpand'],
		enumDescriptions: ['ยุบทุกรายการ (Collapse all items.)', 'ขยายทุกรายการ (Expand all items.)'],
		description: 'รายการใน Outline เริ่มแบบยุบหรือขยาย (Controls whether Outline items are collapsed or expanded.)'
	},
	{
		id: 'outline.problems.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง error และ warning บนรายการใน Outline (Show errors and warnings on Outline elements. Overwritten by `#problems.visibility#` when it is off.)'
	},
	{
		id: 'outline.problems.colors',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'ใช้สีกับรายการที่มี error หรือ warning ใน Outline (Use colors for errors and warnings on Outline elements. Overwritten by `#problems.visibility#` when it is off.)'
	},
	{
		id: 'outline.problems.badges',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงจำนวนปัญหาเป็น badge บนรายการใน Outline (Use badges for errors and warnings on Outline elements. Overwritten by `#problems.visibility#` when it is off.)'
	},
	{
		id: 'outline.showFiles',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงไฟล์ใน Outline (When enabled, Outline shows `file`-symbols.)'
	},
	{
		id: 'outline.showModules',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงmoduleใน Outline (When enabled, Outline shows `module`-symbols.)'
	},
	{
		id: 'outline.showNamespaces',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงnamespaceใน Outline (When enabled, Outline shows `namespace`-symbols.)'
	},
	{
		id: 'outline.showPackages',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงpackageใน Outline (When enabled, Outline shows `package`-symbols.)'
	},
	{
		id: 'outline.showClasses',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงคลาสใน Outline (When enabled, Outline shows `class`-symbols.)'
	},
	{
		id: 'outline.showMethods',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงเมธอดใน Outline (When enabled, Outline shows `method`-symbols.)'
	},
	{
		id: 'outline.showProperties',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงpropertyใน Outline (When enabled, Outline shows `property`-symbols.)'
	},
	{
		id: 'outline.showFields',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงfieldใน Outline (When enabled, Outline shows `field`-symbols.)'
	},
	{
		id: 'outline.showConstructors',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงconstructorใน Outline (When enabled, Outline shows `constructor`-symbols.)'
	},
	{
		id: 'outline.showEnums',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงenumใน Outline (When enabled, Outline shows `enum`-symbols.)'
	},
	{
		id: 'outline.showInterfaces',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงinterfaceใน Outline (When enabled, Outline shows `interface`-symbols.)'
	},
	{
		id: 'outline.showFunctions',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงฟังก์ชันใน Outline (When enabled, Outline shows `function`-symbols.)'
	},
	{
		id: 'outline.showVariables',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวแปรใน Outline (When enabled, Outline shows `variable`-symbols.)'
	},
	{
		id: 'outline.showConstants',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงค่าคงที่ใน Outline (When enabled, Outline shows `constant`-symbols.)'
	},
	{
		id: 'outline.showStrings',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงstringใน Outline (When enabled, Outline shows `string`-symbols.)'
	},
	{
		id: 'outline.showNumbers',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวเลขใน Outline (When enabled, Outline shows `number`-symbols.)'
	},
	{
		id: 'outline.showBooleans',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงbooleanใน Outline (When enabled, Outline shows `boolean`-symbols.)'
	},
	{
		id: 'outline.showArrays',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงarrayใน Outline (When enabled, Outline shows `array`-symbols.)'
	},
	{
		id: 'outline.showObjects',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงobjectใน Outline (When enabled, Outline shows `object`-symbols.)'
	},
	{
		id: 'outline.showKeys',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงkeyใน Outline (When enabled, Outline shows `key`-symbols.)'
	},
	{
		id: 'outline.showNull',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงnullใน Outline (When enabled, Outline shows `null`-symbols.)'
	},
	{
		id: 'outline.showEnumMembers',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงสมาชิก enumใน Outline (When enabled, Outline shows `enumMember`-symbols.)'
	},
	{
		id: 'outline.showStructs',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงstructใน Outline (When enabled, Outline shows `struct`-symbols.)'
	},
	{
		id: 'outline.showEvents',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงeventใน Outline (When enabled, Outline shows `event`-symbols.)'
	},
	{
		id: 'outline.showOperators',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวดำเนินการใน Outline (When enabled, Outline shows `operator`-symbols.)'
	},
	{
		id: 'outline.showTypeParameters',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงtype parameterใน Outline (When enabled, Outline shows `typeParameter`-symbols.)'
	}
];
