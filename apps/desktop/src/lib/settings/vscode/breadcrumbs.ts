// VS Code settings: breadcrumbs.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const BREADCRUMBS_SETTINGS: SettingSchema[] = [
	{
		id: 'breadcrumbs.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'เปิดหรือปิดแถบ breadcrumbs สำหรับนำทาง (Enable/disable navigation breadcrumbs.)'
	},
	{
		id: 'breadcrumbs.filePath',
		group: 'Workbench',
		type: 'string',
		default: 'on',
		enum: ['on', 'off', 'last'],
		enumDescriptions: [
			'แสดง path ทั้งหมด (Show the file path in the breadcrumbs view.)',
			'ไม่แสดง path (Do not show the file path in the breadcrumbs view.)',
			'แสดงเฉพาะชื่อไฟล์ (Only show the last element of the file path in the breadcrumbs view.)'
		],
		description: 'แสดง path ของไฟล์ใน breadcrumbs หรือไม่และแสดงอย่างไร (Controls whether and how file paths are shown in the breadcrumbs view.)'
	},
	{
		id: 'breadcrumbs.symbolPath',
		group: 'Workbench',
		type: 'string',
		default: 'on',
		enum: ['on', 'off', 'last'],
		enumDescriptions: [
			'แสดงทุก symbol (Show all symbols in the breadcrumbs view.)',
			'ไม่แสดง symbol (Do not show symbols in the breadcrumbs view.)',
			'แสดงเฉพาะ symbol ปัจจุบัน (Only show the current symbol in the breadcrumbs view.)'
		],
		description: 'แสดง symbol ใน breadcrumbs หรือไม่และแสดงอย่างไร (Controls whether and how symbols are shown in the breadcrumbs view.)'
	},
	{
		id: 'breadcrumbs.symbolSortOrder',
		group: 'Workbench',
		type: 'string',
		default: 'position',
		enum: ['position', 'name', 'type'],
		enumDescriptions: [
			'เรียงตามตำแหน่งในไฟล์ (Show symbol outline in file position order.)',
			'เรียงตามชื่อ (Show symbol outline in alphabetical order.)',
			'เรียงตามชนิดของ symbol (Show symbol outline in symbol type order.)'
		],
		description: 'ลำดับของ symbol ในรายการที่เปิดจาก breadcrumbs (Controls how symbols are sorted in the breadcrumbs outline view.)'
	},
	{
		id: 'breadcrumbs.icons',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงไอคอนใน breadcrumbs (Render breadcrumb items with icons.)'
	},
	{
		id: 'breadcrumbs.symbolPathSeparator',
		group: 'Workbench',
		type: 'string',
		default: '.',
		description: 'ตัวคั่นเมื่อคัดลอก path ของ symbol จาก breadcrumbs (The separator used when copying the breadcrumb symbol path.)'
	},
	{
		id: 'breadcrumbs.showFiles',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด file ใน breadcrumbs (When enabled breadcrumbs show `file`-symbols.)'
	},
	{
		id: 'breadcrumbs.showModules',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด module ใน breadcrumbs (When enabled breadcrumbs show `module`-symbols.)'
	},
	{
		id: 'breadcrumbs.showNamespaces',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด namespace ใน breadcrumbs (When enabled breadcrumbs show `namespace`-symbols.)'
	},
	{
		id: 'breadcrumbs.showPackages',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด package ใน breadcrumbs (When enabled breadcrumbs show `package`-symbols.)'
	},
	{
		id: 'breadcrumbs.showClasses',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด class ใน breadcrumbs (When enabled breadcrumbs show `class`-symbols.)'
	},
	{
		id: 'breadcrumbs.showMethods',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด method ใน breadcrumbs (When enabled breadcrumbs show `method`-symbols.)'
	},
	{
		id: 'breadcrumbs.showProperties',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด property ใน breadcrumbs (When enabled breadcrumbs show `property`-symbols.)'
	},
	{
		id: 'breadcrumbs.showFields',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด field ใน breadcrumbs (When enabled breadcrumbs show `field`-symbols.)'
	},
	{
		id: 'breadcrumbs.showConstructors',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด constructor ใน breadcrumbs (When enabled breadcrumbs show `constructor`-symbols.)'
	},
	{
		id: 'breadcrumbs.showEnums',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด enum ใน breadcrumbs (When enabled breadcrumbs show `enum`-symbols.)'
	},
	{
		id: 'breadcrumbs.showInterfaces',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด interface ใน breadcrumbs (When enabled breadcrumbs show `interface`-symbols.)'
	},
	{
		id: 'breadcrumbs.showFunctions',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด function ใน breadcrumbs (When enabled breadcrumbs show `function`-symbols.)'
	},
	{
		id: 'breadcrumbs.showVariables',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด variable ใน breadcrumbs (When enabled breadcrumbs show `variable`-symbols.)'
	},
	{
		id: 'breadcrumbs.showConstants',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด constant ใน breadcrumbs (When enabled breadcrumbs show `constant`-symbols.)'
	},
	{
		id: 'breadcrumbs.showStrings',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด string ใน breadcrumbs (When enabled breadcrumbs show `string`-symbols.)'
	},
	{
		id: 'breadcrumbs.showNumbers',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด number ใน breadcrumbs (When enabled breadcrumbs show `number`-symbols.)'
	},
	{
		id: 'breadcrumbs.showBooleans',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด boolean ใน breadcrumbs (When enabled breadcrumbs show `boolean`-symbols.)'
	},
	{
		id: 'breadcrumbs.showArrays',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด array ใน breadcrumbs (When enabled breadcrumbs show `array`-symbols.)'
	},
	{
		id: 'breadcrumbs.showObjects',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด object ใน breadcrumbs (When enabled breadcrumbs show `object`-symbols.)'
	},
	{
		id: 'breadcrumbs.showKeys',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด key ใน breadcrumbs (When enabled breadcrumbs show `key`-symbols.)'
	},
	{
		id: 'breadcrumbs.showNull',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด null ใน breadcrumbs (When enabled breadcrumbs show `null`-symbols.)'
	},
	{
		id: 'breadcrumbs.showEnumMembers',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด enum member ใน breadcrumbs (When enabled breadcrumbs show `enumMember`-symbols.)'
	},
	{
		id: 'breadcrumbs.showStructs',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด struct ใน breadcrumbs (When enabled breadcrumbs show `struct`-symbols.)'
	},
	{
		id: 'breadcrumbs.showEvents',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด event ใน breadcrumbs (When enabled breadcrumbs show `event`-symbols.)'
	},
	{
		id: 'breadcrumbs.showOperators',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด operator ใน breadcrumbs (When enabled breadcrumbs show `operator`-symbols.)'
	},
	{
		id: 'breadcrumbs.showTypeParameters',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง symbol ชนิด type parameter ใน breadcrumbs (When enabled breadcrumbs show `typeParameter`-symbols.)'
	}
];
