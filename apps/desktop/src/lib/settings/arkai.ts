// Arkai's model providers (Rust `agent/arkai.rs`): user settings only, so a repository can never
// point Arkai at a server. API keys are not settings: they live in the macOS Keychain (Settings ›
// Arkai), and an Authorization header written here is dropped.

import type { JsonSchema } from './jsonSchema';
import type { SettingSchema } from './registry';

const MODEL: JsonSchema = {
	anyOf: [
		{ type: 'string', minLength: 1 },
		{
			type: 'object',
			properties: {
				id: { type: 'string', minLength: 1 },
				name: { type: 'string' },
				contextWindow: { type: 'integer', minimum: 1 },
				maxTokens: { type: 'integer', minimum: 1 },
				light: { type: 'boolean' }
			},
			additionalProperties: false
		}
	]
};

const PROVIDER: JsonSchema = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		baseUrl: { type: 'string', pattern: '^https?://' },
		api: { enum: ['openai', 'anthropic'] },
		models: { type: 'array', items: MODEL },
		headers: { type: 'object', additionalProperties: { type: 'string' } }
	},
	additionalProperties: false
};

export const ARKAI_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.arkai.providers',
		group: 'Agent Chat',
		type: 'json',
		schema: { type: 'object', patternProperties: { '^[a-z0-9][a-z0-9-]{0,39}$': PROVIDER }, additionalProperties: false },
		default: {},
		description:
			'ผู้ให้บริการโมเดลของ Arkai: id → {"baseUrl", "api": "openai" | "anthropic", "models": [...]} เช่น {"openrouter": {"baseUrl": "https://openrouter.ai/api/v1", "models": ["qwen/qwen3-coder"]}} ใช้ได้กับ OpenAI, OpenRouter, Groq, DeepSeek, LM Studio, vLLM และ Ollama (Ollama และ Clyde 1X บน vLLM พอร์ต 8000 ของเครื่องนี้ใช้ได้เลยเมื่อเปิดไว้) ไม่มีรายชื่อโมเดลจะถามจากเซิร์ฟเวอร์ ส่วน API key เก็บในพวงกุญแจที่ Settings › Arkai ไม่ใช่ที่นี่ (Arkai\'s model providers: id → baseUrl, api, models. Without models, the server is asked for them; Ollama and Clyde 1X (vLLM on port 8000) are found on this Mac by themselves. API keys go in the Keychain from Settings › Arkai, never here.)',
		scope: 'application'
	}
];
