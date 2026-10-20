// VS Code settings: html.* (vscode-html-language-server). Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const HTML_SETTINGS: SettingSchema[] = [
	{
		id: 'html.format.enable',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'เปิดตัวจัดรูปแบบ HTML (Enable/disable default HTML formatter.)'
	},
	{
		id: 'html.format.wrapLineLength',
		group: 'HTML',
		type: 'number',
		default: 120,
		integer: true,
		description: 'ความยาวบรรทัดสูงสุดก่อนตัดบรรทัด 0 = ไม่ตัด (Maximum amount of characters per line (0 = disable).)'
	},
	{
		id: 'html.format.unformatted',
		group: 'HTML',
		type: 'json',
		schema: { type: ['string', 'null'] },
		default: 'wbr',
		description: 'แท็กที่ไม่จัดรูปแบบ (List of tags, comma separated, that shouldn\'t be reformatted. `null` defaults to all tags listed at https://www.w3.org/TR/html5/dom.html#phrasing-content.)'
	},
	{
		id: 'html.format.contentUnformatted',
		group: 'HTML',
		type: 'json',
		schema: { type: ['string', 'null'] },
		default: 'pre,code,textarea',
		description: 'แท็กที่ไม่จัดรูปแบบเนื้อหาข้างใน (List of tags, comma separated, where the content shouldn\'t be reformatted. `null` defaults to the `pre` tag.)'
	},
	{
		id: 'html.format.indentInnerHtml',
		group: 'HTML',
		type: 'boolean',
		default: false,
		description: 'ย่อหน้าส่วน head และ body (Indent `<head>` and `<body>` sections.)'
	},
	{
		id: 'html.format.preserveNewLines',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'คงบรรทัดว่างก่อน element (Controls whether existing line breaks before elements should be preserved. Only works before elements, not inside tags or for text.)'
	},
	{
		id: 'html.format.maxPreserveNewLines',
		group: 'HTML',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: null,
		description: 'จำนวนบรรทัดว่างสูงสุดที่คงไว้ (Maximum number of line breaks to be preserved in one chunk. Use `null` for unlimited.)'
	},
	{
		id: 'html.format.indentHandlebars',
		group: 'HTML',
		type: 'boolean',
		default: false,
		description: 'จัดรูปแบบและย่อหน้า handlebars (Format and indent `{{#foo}}` and `{{/foo}}`.)'
	},
	{
		id: 'html.format.extraLiners',
		group: 'HTML',
		type: 'json',
		schema: { type: ['string', 'null'] },
		default: 'head, body, /html',
		description: 'แท็กที่ขึ้นบรรทัดว่างก่อนหน้า (List of tags, comma separated, that should have an extra newline before them. `null` defaults to `"head, body, /html"`.)'
	},
	{
		id: 'html.format.wrapAttributes',
		group: 'HTML',
		type: 'string',
		default: 'auto',
		enum: [
			'auto',
			'force',
			'force-aligned',
			'force-expand-multiline',
			'aligned-multiple',
			'preserve',
			'preserve-aligned'
		],
		enumDescriptions: [
			'ตัดเมื่อเกินความยาวบรรทัด (Wrap attributes only when line length is exceeded.)',
			'ทุก attribute ขึ้นบรรทัดใหม่ยกเว้นตัวแรก (Wrap each attribute except first.)',
			'ทุก attribute ขึ้นบรรทัดใหม่และจัดแนว (Wrap each attribute except first and keep aligned.)',
			'ขึ้นบรรทัดใหม่ทุก attribute เมื่อเกินความยาว (Wrap each attribute.)',
			'ตัดเมื่อเกินความยาวและจัดแนว (Wrap when line length is exceeded, align attributes vertically.)',
			'คงการตัดบรรทัดเดิม (Preserve wrapping of attributes.)',
			'คงการตัดบรรทัดเดิมและจัดแนว (Preserve wrapping of attributes but align.)'
		],
		description: 'การตัดบรรทัด attribute (Wrap attributes.)'
	},
	{
		id: 'html.format.wrapAttributesIndentSize',
		group: 'HTML',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: null,
		description: 'ระยะย่อหน้าของ attribute ที่ถูกตัดบรรทัด (Indent wrapped attributes to after N characters. Use `null` to use the default indent size. Ignored if `#html.format.wrapAttributes#` is set to `aligned`.)'
	},
	{
		id: 'html.format.templating',
		group: 'HTML',
		type: 'boolean',
		default: false,
		description: 'รองรับ template เช่น django erb handlebars php (Honor django, erb, handlebars and php templating language tags.)'
	},
	{
		id: 'html.format.unformattedContentDelimiter',
		group: 'HTML',
		type: 'string',
		default: '',
		description: 'ข้อความคั่นที่เนื้อหาระหว่างนั้นไม่ถูกจัดรูปแบบ (Keep text content together between this string.)'
	},
	{
		id: 'html.suggest.html5',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'แนะนำแท็ก attribute และค่าของ HTML5 (Controls whether the built-in HTML language support suggests HTML5 tags, properties and values.)'
	},
	{
		id: 'html.suggest.hideEndTagSuggestions',
		group: 'HTML',
		type: 'boolean',
		default: false,
		description: 'ไม่แนะนำแท็กปิด (Controls whether the built-in HTML language support suggests closing tags. When disabled, end tag completions like `</div>` will not be shown.)'
	},
	{
		id: 'html.validate.scripts',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'ตรวจ script ที่ฝังอยู่ (Controls whether the built-in HTML language support validates embedded scripts.)'
	},
	{
		id: 'html.validate.styles',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'ตรวจ style ที่ฝังอยู่ (Controls whether the built-in HTML language support validates embedded styles.)'
	},
	{
		id: 'html.hover.documentation',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'แสดงคำอธิบายแท็กและ attribute ใน hover (Show tag and attribute documentation in hover.)'
	},
	{
		id: 'html.hover.references',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'แสดงลิงก์อ้างอิง MDN ใน hover (Show references to MDN in hover.)'
	},
	{
		id: 'html.autoCreateQuotes',
		group: 'HTML',
		type: 'boolean',
		default: true,
		description: 'ใส่เครื่องหมายคำพูดเมื่อพิมพ์ = หลัง attribute (Enable/disable auto creation of quotes for HTML attribute assignment. The type of quotes can be configured by `#html.completion.attributeDefaultValue#`.)'
	},
	{
		id: 'html.completion.attributeDefaultValue',
		group: 'HTML',
		type: 'string',
		default: 'doublequotes',
		enum: ['doublequotes', 'singlequotes', 'empty'],
		enumDescriptions: [
			'ใส่ double quote (Attribute value is set to "".)',
			'ใส่ single quote (Attribute value is set to \'\'.)',
			'ไม่ใส่ค่า (Attribute value is not set.)'
		],
		description: 'ค่าเริ่มต้นเมื่อเติม attribute (Controls the default value for attributes when completion is accepted.)'
	},
	{
		id: 'html.trace.server',
		group: 'HTML',
		type: 'string',
		default: 'off',
		enum: ['off', 'messages', 'verbose'],
		description: 'บันทึกข้อความระหว่าง Kingu กับ HTML language server ลงช่อง Output ของ server (Traces the communication between VS Code and the HTML language server.)'
	}
];
