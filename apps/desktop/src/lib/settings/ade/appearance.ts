// Orca's Appearance / General pages: app-wide look and tab behaviour (System section, group Appearance).
// Applied by ade/appearance.svelte.ts (UI font, side bar tint) and adeLayout (Ctrl+Tab order).
import type { SettingSchema } from '../registry';

const G = 'Appearance';

export const APPEARANCE_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.ui.fontFamily',
		group: G,
		type: 'string',
		default: '',
		description: 'ฟอนต์ของหน้าจอ Kingu (เมนู แถบข้าง ปุ่ม) เว้นว่างใช้ฟอนต์ของระบบ (Orca: appFontFamily) (Font of the Kingu interface; empty uses the default.)',
		scope: 'application'
	},
	{
		id: 'kingu.sidebar.appearance',
		group: G,
		type: 'string',
		default: 'default',
		enum: ['default', 'match-terminal', 'tinted'],
		enumDescriptions: [
			'สีของธีม (The theme\'s side bar color.)',
			'ใช้สีพื้นของ terminal (The terminal background.)',
			'ทับด้วยสี kingu.sidebar.tintColor ที่ความทึบ kingu.sidebar.tintOpacity (A tint of kingu.sidebar.tintColor at kingu.sidebar.tintOpacity.)'
		],
		description: 'พื้นของแถบข้างใน Agents (Orca: leftSidebarAppearanceMode) (Surface of the Agents side bar.)',
		scope: 'application'
	},
	{
		id: 'kingu.sidebar.tintColor',
		group: G,
		type: 'string',
		default: '#18181b',
		description: 'สีที่ทับแถบข้างเมื่อ kingu.sidebar.appearance เป็น tinted เป็น hex (Orca: leftSidebarTintColor) (Side bar tint color, as hex.)',
		scope: 'application'
	},
	{
		id: 'kingu.sidebar.tintOpacity',
		group: G,
		type: 'number',
		default: 0.08,
		minimum: 0,
		maximum: 0.35,
		description: 'ความทึบของสีที่ทับแถบข้าง 0–0.35 (Orca: leftSidebarTintOpacity) (Side bar tint opacity, 0–0.35.)',
		scope: 'application'
	},
	{
		id: 'kingu.tabs.ctrlTabOrder',
		group: G,
		type: 'string',
		default: 'mru',
		enum: ['mru', 'sequential'],
		enumDescriptions: ['ตามที่ใช้ล่าสุด (By recent use.)', 'ตามลำดับแท็บจากแท็บปัจจุบัน (In tab strip order from the active tab.)'],
		description: 'Ctrl+Tab ในแท็บของ worktree เลือกแท็บถัดไปอย่างไร (Orca: ctrlTabOrderMode) (How Ctrl+Tab picks the next tab of a worktree.)',
		scope: 'application'
	}
];
