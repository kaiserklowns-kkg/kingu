// VS Code settings: keyboard.*, application.* and http.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const APPLICATION_SETTINGS: SettingSchema[] = [
	{
		id: 'keyboard.dispatch',
		group: 'Application',
		type: 'string',
		default: 'code',
		enum: ['code', 'keyCode'],
		description: 'จับคู่คีย์ลัดจากตำแหน่งปุ่มบนคีย์บอร์ด หรือจากตัวอักษรที่ปุ่มพิมพ์ตาม layout (Controls the dispatching logic for key presses to use either `code` (recommended) or `keyCode`.)',
		scope: 'application'
	},
	{
		id: 'application.shellEnvironmentResolutionTimeout',
		group: 'Application',
		type: 'number',
		default: 10,
		minimum: 1,
		maximum: 120,
		description: 'เวลาสูงสุดเป็นวินาทีที่รออ่าน PATH จาก login shell ตอนเปิด Kingu จาก Dock หรือ Finder มีผลเมื่อเปิด Kingu ครั้งถัดไป (Controls the timeout in seconds before giving up resolving the shell environment when the application is not already launched from a terminal. See our [documentation](https://go.microsoft.com/fwlink/?linkid=2149667) for more information.)',
		scope: 'application'
	},
	{
		id: 'http.proxy',
		group: 'Application',
		type: 'string',
		default: '',
		pattern: '^(https?|socks|socks4a?|socks5h?)://([^:]*(:[^@]*)?@)?([^:]+|\\[[:0-9a-fA-F]+\\])(:\\d+)?/?$|^$',
		description: 'proxy ที่ Kingu ใช้ออกอินเทอร์เน็ต เช่น http://proxy.example.com:8080 ใช้กับคำขอของ Kingu เอง คือเซิร์ฟเวอร์ทีม, Linear และ usage ของบัญชี AI และส่งเป็น HTTPS_PROXY/HTTP_PROXY ให้ git, gh, language server, agent host และ agent CLI ใน terminal ของ ADE ว่างไว้เพื่อใช้ค่าจากตัวแปร http_proxy/https_proxy (The proxy setting to use. If not set, will be inherited from the `http_proxy` and `https_proxy` environment variables. When during [remote development](https://aka.ms/vscode-remote) the `#http.useLocalProxyConfiguration#` setting is disabled this setting can be configured in the local and the remote settings separately.)',
		scope: 'application'
	},
	{
		id: 'http.noProxy',
		group: 'Application',
		type: 'array',
		items: 'string',
		default: [],
		description: 'ชื่อโดเมนที่ไม่ผ่าน proxy เช่น localhost หรือ .corp.example.com ส่งเป็น NO_PROXY ให้โปรแกรมที่ Kingu เรียกด้วย (Specifies domain names for which proxy settings should be ignored for HTTP/HTTPS requests. When during [remote development](https://aka.ms/vscode-remote) the `#http.useLocalProxyConfiguration#` setting is disabled this setting can be configured in the local and the remote settings separately.)',
		scope: 'application'
	},
	{
		id: 'http.proxyStrictSSL',
		group: 'Application',
		type: 'boolean',
		default: true,
		description: 'ตรวจใบรับรอง TLS ของคำขอของ Kingu เองเมื่อใช้ proxy ปิดเฉพาะเมื่อ proxy ขององค์กรเปลี่ยนใบรับรอง ซึ่งไม่ปลอดภัย (Controls whether the proxy server certificate should be verified against the list of supplied CAs. When during [remote development](https://aka.ms/vscode-remote) the `#http.useLocalProxyConfiguration#` setting is disabled this setting can be configured in the local and the remote settings separately.)',
		scope: 'application'
	},
	{
		id: 'http.proxyAuthorization',
		group: 'Application',
		type: 'json',
		schema: { type: ['null', 'string'] },
		default: null,
		description: 'ค่าที่ส่งเป็น header Proxy-Authorization ในคำขอของ Kingu เอง เช่น Basic … ส่วนโปรแกรมอื่นให้ใส่ชื่อผู้ใช้และรหัสผ่านใน URL ของ http.proxy แทน (The value to send as the `Proxy-Authorization` header for every network request. When during [remote development](https://aka.ms/vscode-remote) the `#http.useLocalProxyConfiguration#` setting is disabled this setting can be configured in the local and the remote settings separately.)',
		scope: 'application'
	}
];
