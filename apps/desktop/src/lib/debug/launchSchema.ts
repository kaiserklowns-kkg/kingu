// The JSON schema of launch.json (VS Code: debugSchemas.ts launchSchema + the debuggers'
// configurationAttributes), for completion, hovers and validation in the editor; the configuration
// snippets of Add Configuration… are its `defaultSnippets`, as VS Code offers them in the array.

import { CONFIG_SNIPPETS } from './launch.ts';

export const LAUNCH_SCHEMA_URI = 'kingu://schemas/launch';
export const LAUNCH_FILE_MATCH = ['**/.vscode/launch.json', '**/.kingu/launch.json'];

type Prop = Record<string, unknown>;
const str = (description: string, extra: Prop = {}): Prop => ({ type: 'string', description, ...extra });
const bool = (description: string, dflt?: boolean): Prop => ({ type: 'boolean', description, ...(dflt !== undefined ? { default: dflt } : {}) });
const strings = (description: string, dflt: string[] = []): Prop => ({ type: 'array', items: { type: 'string' }, description, default: dflt });
const env: Prop = { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Environment variables for the program. (ตัวแปรสภาพแวดล้อมของโปรแกรม)', default: {} };
const pid: Prop = { anyOf: [{ type: 'integer' }, { type: 'string' }], description: 'Process id to attach to; "${command:pickProcess}" asks. (process id ที่จะ attach)', default: '${command:pickProcess}' };
const taskRef: Prop = { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'Task to run before (preLaunchTask) or after (postDebugTask) the session. (task ที่จะรันก่อนหรือหลัง debug)' };

/** The attributes of every configuration Kingu's debuggers take, by debugger (lldb-dap, Delve, debugpy, js-debug). */
const PROPERTIES: Record<string, Prop> = {
	type: { type: 'string', enum: ['lldb', 'go', 'debugpy', 'python', 'node', 'pwa-node', 'node-terminal', 'chrome', 'pwa-chrome', 'msedge', 'pwa-msedge'], description: 'Type of configuration. (ชนิดของ debugger)' },
	request: { type: 'string', enum: ['launch', 'attach'], description: 'Request type of configuration. Can be "launch" or "attach". (launch หรือ attach)' },
	name: str('Name of configuration; appears in the launch configuration dropdown menu. (ชื่อที่แสดงในรายการ)'),
	preLaunchTask: taskRef,
	postDebugTask: taskRef,
	internalConsoleOptions: { type: 'string', enum: ['neverOpen', 'openOnSessionStart', 'openOnFirstSessionStart'], description: 'Controls when the internal Debug Console should open. (เปิด Debug Console เมื่อใด)' },
	// Shared launch attributes.
	program: str('Path to the program to debug. (พาธของโปรแกรม)'),
	args: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }], description: 'Command line arguments passed to the program. (อาร์กิวเมนต์)', default: [] },
	cwd: str('Working directory of the program. (โฟลเดอร์ทำงาน)', { default: '${workspaceFolder}' }),
	env,
	stopOnEntry: bool('Stop after launch. (หยุดทันทีหลังเริ่ม)', false),
	console: { type: 'string', enum: ['internalConsole', 'integratedTerminal', 'externalTerminal'], description: 'Where to launch the debug target. (รันโปรแกรมที่ใด)' },
	// lldb-dap
	pid,
	initCommands: strings('LLDB commands run when the debugger starts (lldb-dap). (คำสั่ง LLDB ตอนเริ่ม)'),
	preRunCommands: strings('LLDB commands run before launching (lldb-dap). (คำสั่ง LLDB ก่อน launch)'),
	sourceMap: { type: 'array', description: 'Source path remappings (lldb-dap). (แมปพาธซอร์ส)' },
	// Delve
	mode: { type: 'string', enum: ['auto', 'debug', 'test', 'exec', 'replay', 'core', 'local', 'remote'], description: 'Delve mode: debug a package, test, exec a binary, or attach to a local/remote process. (โหมดของ Delve)' },
	buildFlags: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Go build flags. (flag ของ go build)' },
	dlvFlags: strings('Extra flags for dlv. (flag เพิ่มของ dlv)'),
	processId: pid,
	// debugpy
	module: str('Python module to run, like python -m. (โมดูล Python)'),
	python: str('Python interpreter to run the program with. (ตัวแปลภาษา Python)'),
	justMyCode: bool('Debug only user-written code. (debug เฉพาะโค้ดของเรา)', true),
	connect: { type: 'object', properties: { host: { type: 'string', default: 'localhost' }, port: { type: 'integer', default: 5678 } }, description: 'Host and port of a debugpy listening for attach. (host และ port ที่จะ attach)' },
	django: bool('Django debugging. (debug Django)', false),
	// js-debug
	runtimeExecutable: str('Runtime to use: an absolute path or the name of a runtime on PATH (node, npm, bun…). (runtime ที่ใช้)', { default: 'node' }),
	runtimeArgs: strings('Arguments passed to the runtime executable. (อาร์กิวเมนต์ของ runtime)'),
	port: { type: 'integer', description: 'Debug port to attach to (node --inspect: 9229). (พอร์ตที่จะ attach)', default: 9229 },
	address: str('TCP/IP address of the process to be debugged. (ที่อยู่ของโปรเซส)', { default: 'localhost' }),
	skipFiles: strings('Files or globs to skip when stepping. (ไฟล์ที่ข้ามตอน step)', ['<node_internals>/**']),
	outFiles: strings('Globs of the generated JavaScript files sourcemaps map from. (ไฟล์ JavaScript ที่ build แล้ว)', ['${workspaceFolder}/**/*.(m|c|)js', '!**/node_modules/**']),
	sourceMaps: bool('Use JavaScript source maps (if they exist). (ใช้ source map)', true),
	resolveSourceMapLocations: strings('Locations where source maps may be used. (ที่ที่ใช้ source map ได้)'),
	restart: bool('Restart the connection when it ends. (เชื่อมต่อใหม่เมื่อหลุด)', false),
	autoAttachChildProcesses: bool('Attach to child processes too. (attach โปรเซสลูกด้วย)', true),
	url: str('The URL to open in the browser (chrome, msedge). (URL ที่จะเปิด)', { default: 'http://localhost:8080' }),
	webRoot: str('The root of the served files (chrome, msedge). (โฟลเดอร์รากของเว็บ)', { default: '${workspaceFolder}' }),
	command: str('Command to run in the terminal (node-terminal). (คำสั่งที่รันในเทอร์มินัล)', { default: 'npm start' })
};

/** `inputs` of launch.json and tasks.json (VS Code: configurationResolverSchema). */
export const INPUTS_SCHEMA: Prop = {
	type: 'array',
	description: 'User inputs. Used for defining user input prompts, such as free string input or a choice from several options. (input ที่ถามผู้ใช้ ใช้กับ ${input:id})',
	items: {
		type: 'object',
		required: ['id', 'type'],
		properties: {
			id: str("The input's id is used to associate an input with a variable of the form ${input:id}. (id ที่ใช้ใน ${input:id})"),
			type: { type: 'string', enum: ['promptString', 'pickString', 'command'], description: 'The type of user input prompt to use. (ชนิดของการถาม)' },
			description: str('The description is shown when the user is prompted for input. (ข้อความที่แสดงตอนถาม)'),
			default: str('The default value for the input. (ค่าเริ่มต้น)'),
			password: bool('Set to true to input with a password prompt that will not show the typed value. (ซ่อนข้อความที่พิมพ์)', false),
			options: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', required: ['value'], properties: { label: { type: 'string' }, value: { type: 'string' } } }] }, description: 'An array of options for the user to pick from. (ตัวเลือกให้เลือก)' },
			command: str('The command to execute for this input variable. (คำสั่งที่รันเพื่อเอาค่า)'),
			args: { description: 'Optional arguments passed to the command. (อาร์กิวเมนต์ของคำสั่ง)' }
		},
		defaultSnippets: [
			{ label: 'promptString', body: { id: '$1', type: 'promptString', description: '$2' } },
			{ label: 'pickString', body: { id: '$1', type: 'pickString', description: '$2', options: ['$3'] } },
			{ label: 'command', body: { id: '$1', type: 'command', command: '$2' } }
		]
	}
};

export function launchSchema(): Record<string, unknown> {
	return {
		type: 'object',
		properties: {
			version: { type: 'string', enum: ['0.2.0'], description: 'Version of this file format. (เวอร์ชันของไฟล์)', default: '0.2.0' },
			configurations: {
				type: 'array',
				description: 'List of configurations. Add new configurations or edit existing ones by using IntelliSense. (รายการ launch configuration)',
				items: {
					type: 'object',
					required: ['type', 'request', 'name'],
					properties: PROPERTIES,
					defaultSnippets: CONFIG_SNIPPETS.map((s) => ({ label: s.label, description: s.description, body: s.body }))
				},
				default: []
			},
			compounds: {
				type: 'array',
				description: 'List of compounds. Each compound references multiple configurations which will get launched together. (รายการ compound ที่เริ่มหลาย configuration พร้อมกัน)',
				items: {
					type: 'object',
					required: ['name', 'configurations'],
					properties: {
						name: str('Name of compound. Appears in the launch configuration drop down menu. (ชื่อ compound)'),
						configurations: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, folder: { type: 'string' } } }] }, description: 'Names of configurations that will be started as part of this compound. (ชื่อ configuration ที่เริ่มพร้อมกัน)' },
						stopAll: bool('Controls whether manually terminating one session will stop all of the compound sessions. (หยุดตัวหนึ่งแล้วหยุดทั้งหมด)', false),
						preLaunchTask: taskRef
					},
					defaultSnippets: [{ label: 'Compound', body: { name: 'Compound', configurations: [] } }]
				},
				default: []
			},
			inputs: INPUTS_SCHEMA
		}
	};
}
