import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
	getWorker(_id, label) {
		if (label === 'json') return new JsonWorker();
		if (label === 'typescript' || label === 'javascript') return new TsWorker();
		return new EditorWorker();
	}
};

const byExtension: Record<string, string> = {
	ts: 'typescript',
	js: 'javascript',
	svelte: 'html',
	rs: 'rust',
	go: 'go',
	json: 'json',
	toml: 'ini',
	md: 'markdown',
	css: 'css',
	html: 'html'
};

export function languageFor(path: string): string {
	return byExtension[path.split('.').pop() ?? ''] ?? 'plaintext';
}

export { monaco };
