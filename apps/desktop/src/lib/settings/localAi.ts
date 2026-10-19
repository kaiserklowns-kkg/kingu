// Local AI settings (lib/localAi): grey-text completions and semantic search on the user's own
// model server, and smart Find in Files. Everything that sends code somewhere is off by default
// and user-only: a repository's settings cannot turn it on or point it at another server.

import type { SettingSchema } from './registry';

export const FIM_TEMPLATES = ['auto', 'qwen', 'codegemma', 'deepseek', 'codellama', 'starcoder', 'codestral'] as const;

export const LOCAL_AI_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.completions.enabled',
		group: 'Local AI',
		type: 'boolean',
		default: false,
		description:
			'เติมโค้ดต่อจากเคอร์เซอร์เป็นข้อความสีเทาขณะพิมพ์ กด Tab เพื่อรับ กด Esc เพื่อปิด ใช้โมเดลบนเซิร์ฟเวอร์ของคุณเอง เช่น Ollama (Suggest the rest of the code as grey text while you type; Tab accepts it, Escape dismisses it. Runs on your own model server, such as Ollama.)',
		scope: 'application'
	},
	{
		id: 'kingu.completions.provider',
		group: 'Local AI',
		type: 'string',
		default: 'ollama',
		enum: ['ollama', 'openai'],
		enumDescriptions: ['Ollama (/api/generate, /api/embed)', 'OpenAI-compatible: LM Studio, llama.cpp, vLLM (/v1/completions, /v1/embeddings)'],
		description: 'ชนิดของเซิร์ฟเวอร์โมเดล ใช้ทั้งการเติมโค้ดและการค้นหาตามความหมาย (The kind of model server, for completions and semantic search.)',
		scope: 'application'
	},
	{
		id: 'kingu.completions.endpoint',
		group: 'Local AI',
		type: 'string',
		default: 'http://127.0.0.1:11434',
		description: 'ที่อยู่ของเซิร์ฟเวอร์โมเดล เช่น http://127.0.0.1:11434 สำหรับ Ollama หรือ http://localhost:1234/v1 (The model server address, e.g. http://127.0.0.1:11434 for Ollama or http://localhost:1234/v1.)',
		scope: 'application'
	},
	{
		id: 'kingu.completions.apiKey',
		group: 'Local AI',
		type: 'string',
		default: '',
		description: 'API key ที่ส่งเป็น Bearer token ถ้าเซิร์ฟเวอร์ต้องการ เว้นว่างสำหรับ Ollama (An API key sent as a Bearer token when the server needs one; leave empty for Ollama.)',
		scope: 'application'
	},
	{
		id: 'kingu.completions.model',
		group: 'Local AI',
		type: 'string',
		default: '',
		description:
			'โมเดลที่ใช้เติมโค้ด ต้องรองรับ fill-in-the-middle เช่น qwen2.5-coder เว้นว่างเพื่อใช้โมเดลเขียนโค้ดตัวแรกที่ติดตั้งใน Ollama (The model that completes code; it must know fill-in-the-middle, e.g. qwen2.5-coder. Empty uses the first coding model installed in Ollama.)',
		scope: 'application'
	},
	{
		id: 'kingu.completions.fimTemplate',
		group: 'Local AI',
		type: 'string',
		default: 'auto',
		enum: FIM_TEMPLATES,
		enumDescriptions: [
			'From the model name',
			'Qwen2.5-Coder, Chyle',
			'CodeGemma',
			'DeepSeek-Coder',
			'Code Llama',
			'StarCoder, Stable Code, Granite Code',
			'Codestral'
		],
		description: 'รูปแบบ prompt แบบ fill-in-the-middle ของโมเดล auto = เดาจากชื่อโมเดล (The model’s fill-in-the-middle prompt format; auto picks it from the model name.)'
	},
	{
		id: 'kingu.completions.debounce',
		group: 'Local AI',
		type: 'number',
		default: 300,
		minimum: 0,
		maximum: 5000,
		integer: true,
		description: 'รอให้หยุดพิมพ์กี่มิลลิวินาทีก่อนขอคำแนะนำ (How long typing must pause, in milliseconds, before a completion is asked for.)'
	},
	{
		id: 'kingu.completions.maxTokens',
		group: 'Local AI',
		type: 'number',
		default: 64,
		minimum: 1,
		maximum: 512,
		integer: true,
		description: 'จำนวน token สูงสุดของคำแนะนำแต่ละครั้ง (The most tokens a completion may have.)'
	},
	{
		id: 'kingu.semanticSearch.enabled',
		group: 'Local AI',
		type: 'boolean',
		default: false,
		description:
			'ค้นหาโค้ดตามความหมาย ทำดัชนี embedding ของ workspace ไว้ในเครื่อง ด้วยเซิร์ฟเวอร์โมเดลเดียวกับการเติมโค้ด (Search the workspace by meaning: an embedding index kept on this computer, made by the same model server as completions.)',
		scope: 'application'
	},
	{
		id: 'kingu.semanticSearch.model',
		group: 'Local AI',
		type: 'string',
		default: 'bge-m3',
		description: 'โมเดล embedding เช่น bge-m3 ซึ่งอ่านภาษาไทยได้ดี เปลี่ยนโมเดลแล้วดัชนีจะถูกสร้างใหม่ (The embedding model, e.g. bge-m3, which reads Thai well; changing it rebuilds the index.)',
		scope: 'application'
	},
	{
		id: 'kingu.search.smart',
		group: 'Search',
		type: 'boolean',
		default: false,
		description:
			'ค้นหาแบบฉลาด: คำค้นธรรมดาเจอทุกตัวพิมพ์ ทุกลำดับคำ และทุกวิธีเขียนชื่อ เช่น stock ledger เจอ stockLedger และ stock_ledger เปิด Regex, Match Case หรือ Whole Word เพื่อค้นตรงตัว (Smart search: a plain query finds its words in any case, any order and however a name is written: `stock ledger` finds `stockLedger` and `stock_ledger`. Turn on Regex, Match Case or Whole Word to search exactly.)'
	}
];
