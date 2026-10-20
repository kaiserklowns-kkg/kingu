// VS Code settings: testing.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const TESTING_SETTINGS: SettingSchema[] = [
	{
		id: 'testing.automaticallyOpenPeekView',
		group: 'Testing',
		type: 'string',
		default: 'never',
		enum: ['failureAnywhere', 'failureInVisibleDocument', 'never'],
		enumDescriptions: [
			'เปิดเองไม่ว่าการทดสอบที่ล้มเหลวจะอยู่ที่ใด (Open automatically no matter where the failure is.)',
			'เปิดเองเมื่อการทดสอบที่ล้มเหลวอยู่ในเอกสารที่มองเห็น (Open automatically when a test fails in a visible document.)',
			'ไม่เปิดเอง (Never automatically open.)'
		],
		description: 'เปิด peek ของข้อผิดพลาดเองเมื่อใด (Configures when the error Peek view is automatically opened.)'
	},
	{
		id: 'testing.countBadge',
		group: 'Testing',
		type: 'string',
		default: 'failed',
		enum: ['failed', 'off', 'passed', 'skipped'],
		enumDescriptions: [
			'แสดงจำนวนการทดสอบที่ล้มเหลว (Show the number of failed tests)',
			'ไม่แสดงตัวเลข (Disable the testing count badge)',
			'แสดงจำนวนการทดสอบที่ผ่าน (Show the number of passed tests)',
			'แสดงจำนวนการทดสอบที่ข้าม (Show the number of skipped tests)'
		],
		description: 'ตัวเลขบนไอคอน Testing ในแถบกิจกรรม (Controls the count badge on the Testing icon on the Activity Bar.)'
	},
	{
		id: 'testing.followRunningTest',
		group: 'Testing',
		type: 'boolean',
		default: false,
		description: 'เลื่อนมุมมอง Test Explorer ตามการทดสอบที่กำลังรัน (Controls whether the running test should be followed in the Test Explorer view.)'
	},
	{
		id: 'testing.defaultGutterClickAction',
		group: 'Testing',
		type: 'string',
		default: 'run',
		enum: ['run', 'debug', 'contextMenu'],
		enumDescriptions: [
			'รันการทดสอบ (Run the test.)',
			'debug การทดสอบ (Debug the test.)',
			'เปิดเมนูตัวเลือกเพิ่มเติม (Open the context menu for more options.)'
		],
		description: 'สิ่งที่ทำเมื่อคลิกซ้ายที่ไอคอนการทดสอบที่ขอบ editor (Controls the action to take when left-clicking on a test decoration in the gutter.)'
	},
	{
		id: 'testing.gutterEnabled',
		group: 'Testing',
		type: 'boolean',
		default: true,
		description: 'แสดงไอคอนการทดสอบที่ขอบ editor (Controls whether test decorations are shown in the editor gutter.)'
	},
	{
		id: 'testing.saveBeforeTest',
		group: 'Testing',
		type: 'boolean',
		default: true,
		description: 'บันทึก editor ที่ยังไม่บันทึกทั้งหมดก่อนรันการทดสอบ (Control whether save all dirty editors before running a test.)'
	},
	{
		id: 'testing.automaticallyOpenTestResults',
		group: 'Testing',
		type: 'string',
		default: 'openOnTestStart',
		enum: ['neverOpen', 'openOnTestStart', 'openOnTestFailure', 'openExplorerOnTestStart'],
		enumDescriptions: [
			'ไม่เปิดเอง (Never automatically open the testing views)',
			'เปิดผลการทดสอบเมื่อเริ่มรัน (Open the test results view when tests start)',
			'เปิดผลการทดสอบเมื่อมีการทดสอบล้มเหลว (Open the test result view on any test failure)',
			'เปิด Test Explorer เมื่อเริ่มรัน (Open the test explorer when tests start)'
		],
		description: 'เปิดผลการทดสอบเมื่อใด (Controls when the testing view should open.)'
	},
	{
		id: 'testing.alwaysRevealTestOnStateChange',
		group: 'Testing',
		type: 'boolean',
		default: false,
		description: 'เลื่อนไปที่การทดสอบทุกครั้งที่สถานะเปลี่ยนเมื่อเปิด testing.followRunningTest ถ้าปิดจะเลื่อนไปเฉพาะการทดสอบที่ล้มเหลว (Always reveal the executed test when `#testing.followRunningTest#` is on. If this setting is turned off, only failed tests will be revealed.)'
	}
];
