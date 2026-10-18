// Language intelligence for the workbench (VS Code: the language client in each language
// extension). Starts a server per language on demand through Rust `lsp_start`, keeps it in sync
// with the Monaco models EditorHost owns, and exposes diagnostics and server status reactively.

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { lspLanguageId } from '#lib/editor/languages.ts';
import { jsonSchema } from '#lib/settings/registry.ts';
import { settingSchemas } from '#lib/settings/schemas.svelte.ts';
import { settings as userSettings } from '#lib/settings/settings.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status as statusBar } from '#lib/workbench/status.svelte.ts';
import { notifications, type Severity } from '#lib/workbench/notifications.svelte.ts';
import { LanguageClient, type ServerStatus } from './client';
import {
	fromSignatureHelp,
	hoverContents,
	markerToDiagnostic,
	relOfUri,
	toDocumentHighlights,
	toLspRange,
	toMonacoTextEdits,
	toRenameLocation,
	toSignatureHelp,
	symbolPath,
	toCompletionItem,
	toLspPosition,
	toMarker,
	toMonacoRange,
	toMonacoSymbols,
	toTargets,
	uriOfRel,
	uriToPath,
	type Crumb
} from './convert';
import {
	configurationValue,
	countDiagnostics,
	DiagnosticsIndex,
	installItems,
	isDisabled,
	parseDisabled,
	progressText,
	SERVERS,
	serverFor,
	statusText,
	type InstallInfo,
	type InstallMethod,
	type ProblemFile,
	type ServerInfo
} from './model';
import type { CodeAction, Command, CompletionItem, Diagnostic, DocumentSymbol, ServerCapabilities, SymbolInformation, WorkspaceEdit } from './protocol';
import { applyWorkspaceEdit, type ApplyResult } from './workspaceEdit';

type MonacoApi = typeof Monaco;
type LspEvent = { type: 'message'; json: string } | { type: 'stderr'; line: string } | { type: 'exit'; code: number | null };
type Session = { info: ServerInfo; client: LanguageClient; id: number | null; ready: Promise<boolean> };
type Doc = { rel: string; uri: string; key: string; model: Monaco.editor.ITextModel; dispose?: () => void };

const MARKER_OWNER = 'lsp';
/** LSP MessageType → notification severity. */
const MESSAGE_SEVERITY: Record<number, Severity> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'info' };
const EXTERNAL_SCHEME = 'kingu-external';
const LOG_LIMIT = 1000;
const SYMBOLS_DELAY_MS = 400;
const CODE_ACTION_COMMAND = 'kingu.lsp.codeAction';
/** Start of Rust's "server not installed" error (`lsp::NOT_INSTALLED`). */
const NOT_INSTALLED = 'ไม่ได้ติดตั้ง';
const INSTALL_POLL_MS = 3000;
/** Give up watching for an install after this long; window focus and Retry still re-check. */
const INSTALL_WATCH_MS = 15 * 60 * 1000;

class Lsp {
	/** Per server key. Absent until a file of that language is opened. */
	status = new SvelteMap<string, ServerStatus>();
	problems = $state.raw<ProblemFile[]>([]);
	counts = $derived(countDiagnostics(this.problems));
	/** Language server output (stderr, logMessage), for the Output panel. */
	log = $state.raw<string[]>([]);
	/** Document symbols per workspace-relative path, for the breadcrumbs. */
	symbols = new SvelteMap<string, (DocumentSymbol | SymbolInformation)[]>();
	/** A busy server's progress for the status bar ("rust-analyzer: Indexing (40%)…"). */
	progress = $derived.by(() => {
		for (const info of SERVERS) {
			const text = progressText(info, this.status.get(info.key));
			if (text) return text;
		}
		return null;
	});
	/** Overrides of the server table's settings, per server key (e.g. `{ 'rust-analyzer': { … } }`). */
	settings: Record<string, Record<string, unknown>> = {};

	#monaco: MonacoApi | undefined;
	#root: Promise<string> | undefined;
	#rootPath = '';
	#sessions = new Map<string, Session>();
	#docs = new Map<Monaco.editor.ITextModel, Doc>();
	#index = new DiagnosticsIndex();
	/** Which server published diagnostics for a URI, so a stopped server's problems can be cleared. */
	#origin = new Map<string, string>();
	#refreshQueued = false;
	/** Monaco providers per server key, replaced whenever that server (re)initializes. */
	#providers = new Map<string, Monaco.IDisposable[]>();
	/** Models created only so a references/definition peek can show files with no open tab. */
	#previews = new Map<string, Monaco.editor.ITextModel>();
	#symbolTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#pendingLog: string[] = [];
	#installWatch = new Map<string, ReturnType<typeof setInterval>>();
	#retrying = new Set<string>();

	/** Called by EditorHost for every model it creates. */
	attach(monaco: MonacoApi, model: Monaco.editor.ITextModel, rel: string) {
		// A language change (Change Language Mode, files.associations) closes the document with the
		// old server and opens it with the new one, as VS Code does.
		if (!this.#languageWatched.has(model)) {
			this.#languageWatched.add(model);
			model.onDidChangeLanguage(() => {
				this.#detach(model);
				this.attach(monaco, model, rel);
			});
		}
		const info = serverFor(model.getLanguageId());
		if (!info || this.#docs.has(model)) return;
		this.#init(monaco);
		const doc: Doc = { rel, uri: '', key: info.key, model };
		this.#docs.set(model, doc);
		const changed = model.onDidChangeContent(() => {
			if (!doc.uri) return;
			this.#sessions.get(info.key)?.client.didChange(doc.uri, model.getValue());
			this.#scheduleSymbols(doc);
		});
		const disposing = model.onWillDispose(() => this.#detach(model));
		doc.dispose = () => {
			changed.dispose();
			disposing.dispose();
		};
		void this.#open(doc);
	}

	#languageWatched = new WeakSet<Monaco.editor.ITextModel>();

	#detach(model: Monaco.editor.ITextModel) {
		const doc = this.#docs.get(model);
		if (!doc) return;
		doc.dispose?.();
		this.#docs.delete(model);
		this.symbols.delete(doc.rel);
		if (doc.uri) this.#sessions.get(doc.key)?.client.didClose(doc.uri);
	}

	didSave(model: Monaco.editor.ITextModel) {
		const doc = this.#docs.get(model);
		if (doc?.uri) this.#sessions.get(doc.key)?.client.didSave(doc.uri);
	}

	/** Status bar entry for a Monaco language id, or null when it has no server. */
	statusFor(languageId: string): { text: string; tooltip: string; state: ServerStatus['state'] } | null {
		const info = serverFor(languageId);
		const s = info && this.status.get(info.key);
		if (!info || !s) return null;
		return { text: statusText(info, s), tooltip: s.message ?? statusText(info, s), state: s.state };
	}

	crumbs(rel: string, line: number, column: number): Crumb[] {
		const syms = this.symbols.get(rel);
		return syms ? symbolPath(syms, toLspPosition({ lineNumber: line, column })) : [];
	}

	/** `#query` (VS Code's workspace symbol search): every running server that offers it, merged. */
	async workspaceSymbols(query: string): Promise<{ name: string; kind: number; container?: string; rel: string; line: number; column: number }[]> {
		const lists = await Promise.all(
			[...this.#sessions.values()].map((s) => (s.client.ready ? s.client.workspaceSymbols(query).catch(() => null) : Promise.resolve(null)))
		);
		const out: { name: string; kind: number; container?: string; rel: string; line: number; column: number }[] = [];
		for (const list of lists)
			for (const sym of list ?? []) {
				const rel = sym.location?.uri ? relOfUri(this.#rootPath, sym.location.uri) : null;
				if (rel === null) continue;
				const start = sym.location.range?.start ?? { line: 0, character: 0 };
				out.push({ name: sym.name, kind: sym.kind, container: sym.containerName, rel, line: start.line + 1, column: start.character + 1 });
			}
		return out;
	}

	/** Whether any running server answers `#` queries. */
	hasWorkspaceSymbols(): boolean {
		return [...this.#sessions.values()].some((s) => !!s.client.capabilities.workspaceSymbolProvider);
	}

	/** Document symbols of an open file: the breadcrumbs' copy, or a fresh request when there is none yet. */
	async documentSymbolsOf(rel: string): Promise<(DocumentSymbol | SymbolInformation)[]> {
		const cached = this.symbols.get(rel);
		if (cached?.length) return cached;
		const doc = [...this.#docs.values()].find((d) => d.rel === rel);
		const client = doc?.uri ? this.#sessions.get(doc.key)?.client : undefined;
		if (!doc || !client?.ready) return cached ?? [];
		const syms = (await client.documentSymbols(doc.uri).catch(() => null)) ?? [];
		if (this.#docs.has(doc.model)) this.symbols.set(rel, syms);
		return syms;
	}

	hasServer(languageId: string) {
		return serverFor(languageId) !== undefined;
	}

	/** Stops the server for `languageId` and starts it again with every open document. */
	async restart(languageId: string) {
		const info = serverFor(languageId);
		if (info) await this.#restartKey(info.key);
	}

	async #restartKey(key: string) {
		await this.#stop(key);
		this.status.delete(key);
		// Providers are registered again once the new session reports its capabilities.
		for (const doc of this.#docs.values()) if (doc.key === key) void this.#open(doc);
	}

	// --- Missing servers (VS Code would offer to install an extension) ---------------------------

	/** Servers that failed to start because their binary was not found. */
	missing(): ServerInfo[] {
		return SERVERS.filter((s) => this.status.get(s.key)?.state === 'not-installed');
	}

	/** Palette "Install Missing…": the current language's server, else a pick among the missing. */
	installMissing(languageId: string) {
		const missing = this.missing();
		const current = missing.find((s) => s.languages.includes(languageId));
		if (current || missing.length === 1) return this.install((current ?? missing[0]).languages[0]);
		if (!missing.length) return statusBar.flash('ไม่มี language server ที่ยังไม่ได้ติดตั้ง');
		quick.pick({
			placeholder: 'เลือก language server ที่จะติดตั้ง',
			items: missing.map((s) => ({ id: s.key, label: s.name, description: s.languages.join(', ') })),
			onAccept: (item) => void this.install(SERVERS.find((s) => s.key === item.id)!.languages[0])
		});
	}

	/** Offers the install commands this machine can run for `languageId`'s server; the chosen one
	 * runs in a panel terminal where the user sees it (never silently). */
	async install(languageId: string) {
		const info = serverFor(languageId);
		if (!info) return;
		let res: InstallInfo;
		try {
			res = await invoke<InstallInfo>('lsp_install_methods', { language: info.languages[0] });
		} catch (e) {
			return notifications.error(e);
		}
		const retry = { id: 'retry', label: 'ลองหาอีกครั้ง', description: `ติดตั้ง ${res.binary} เองแล้ว`, separator: res.methods.length ? 'อื่น ๆ' : undefined };
		quick.pick({
			placeholder: res.methods.length
				? `ติดตั้ง ${res.server} ด้วยคำสั่ง (รันใน terminal)`
				: `ไม่พบ bun, npm, go, rustup, brew, pipx หรือ uv สำหรับติดตั้ง ${res.server} — ติดตั้ง ${res.binary} เองแล้วลองอีกครั้ง`,
			items: [...installItems(res), retry],
			onAccept: (item) => {
				if (item.id === 'retry') void this.retry(info.key, { report: true });
				else this.#runInstall(info, res.server, res.methods[Number(item.id)]);
			}
		});
	}

	#runInstall(info: ServerInfo, server: string, method: InstallMethod) {
		terminals.open({ title: `ติดตั้ง ${server}`, run: method.argv });
		layout.showPanel('terminal');
		statusBar.flash(`กำลังติดตั้ง ${server} ใน terminal — จะเริ่ม language server ให้เมื่อติดตั้งเสร็จ`);
		this.#watchInstall(info.key);
	}

	/** The command is typed into a shell, so its exit is not observable: poll for the binary. */
	#watchInstall(key: string) {
		clearInterval(this.#installWatch.get(key));
		const started = Date.now();
		const timer = setInterval(async () => {
			if (Date.now() - started > INSTALL_WATCH_MS || this.status.get(key)?.state !== 'not-installed') {
				clearInterval(timer);
				this.#installWatch.delete(key);
				return;
			}
			if (await this.retry(key)) {
				clearInterval(timer);
				this.#installWatch.delete(key);
			}
		}, INSTALL_POLL_MS);
		this.#installWatch.set(key, timer);
	}

	/** Re-resolves a missing server's binary; when it is there now, starts it for the open files. */
	async retry(key: string, { report = false } = {}): Promise<boolean> {
		const info = SERVERS.find((s) => s.key === key);
		// The install poll, window focus and Retry can overlap; one restart is enough.
		if (!info || this.#retrying.has(key)) return false;
		this.#retrying.add(key);
		try {
			const found = await invoke<string>('lsp_check', { language: info.languages[0] }).then(
				() => true,
				(e) => (report && notifications.error(e), false)
			);
			if (!found) return false;
			statusBar.flash(`พบ ${info.name} แล้ว — กำลังเริ่ม`);
			await this.#restartKey(key);
			return true;
		} finally {
			this.#retrying.delete(key);
		}
	}

	#retryMissing() {
		for (const s of this.missing()) void this.retry(s.key);
	}

	/** Open Folder: Rust has already killed the old root's servers; forget them and the cached root. */
	reset() {
		for (const key of [...this.#sessions.keys()]) this.#forget(key);
		this.#root = undefined;
		this.#rootPath = '';
		for (const [rel, model] of [...this.#previews]) this.#dropPreview(rel, model);
		this.status.clear();
		this.symbols.clear();
	}

	// --- Sessions --------------------------------------------------------------------------------

	#init(monaco: MonacoApi) {
		if (this.#monaco) return;
		this.#monaco = monaco;
		// Back from installing a server in another app (or a terminal outside Kingu).
		window.addEventListener('focus', () => this.#retryMissing());
		// Go to Definition into another file: open it as a tab and put the cursor on the target.
		monaco.editor.registerCommand(CODE_ACTION_COMMAND, (_accessor, key: string, item: Command | CodeAction) => void this.#runCodeAction(key, item));
		monaco.editor.registerEditorOpener({
			openCodeEditor: (_source, resource, selection) => {
				const at = selection && 'startLineNumber' in selection ? { line: selection.startLineNumber, column: selection.startColumn } : selection ? { line: selection.lineNumber, column: selection.column } : { line: 1, column: 1 };
				if (resource.scheme === EXTERNAL_SCHEME) {
					notifications.warn(`${resource.path} อยู่นอก workspace จึงเปิดไม่ได้`);
					return true;
				}
				if (resource.scheme !== 'file') return false;
				editors.openAt(resource.path.replace(/^\//, ''), at.line, at.column, { preview: true });
				return true;
			}
		});
	}

	async #rootDir(): Promise<string> {
		this.#root ??= invoke<{ workspace: string }>('app_info').then((i) => (this.#rootPath = i.workspace));
		return this.#root;
	}

	async #open(doc: Doc) {
		const info = SERVERS.find((s) => s.key === doc.key);
		if (!info || isDisabled(info, parseDisabled(userSettings.get('kingu.lsp.disabled')))) return;
		const session = await this.#session(doc.key);
		if (!session || !(await session.ready) || !this.#docs.has(doc.model)) return;
		doc.uri = uriOfRel(this.#rootPath, doc.rel);
		session.client.didOpen(doc.uri, lspLanguageId(doc.model.getLanguageId(), doc.rel), doc.model.getValue());
		this.#applyMarkers(doc.uri);
		this.#scheduleSymbols(doc, 0);
	}

	async #session(key: string): Promise<Session | null> {
		const existing = this.#sessions.get(key);
		if (existing) return existing;
		const info = SERVERS.find((s) => s.key === key)!;
		const root = await this.#rootDir();
		const again = this.#sessions.get(key);
		if (again) return again;

		let id: number | null = null;
		let chain: Promise<unknown> = Promise.resolve();
		// Sends are chained so the server sees them in order (separate IPC calls may not be).
		const write = (json: string) => {
			chain = chain.then(() => (id === null ? undefined : invoke('lsp_send', { id, message: json }))).catch((e) => this.#append(`${info.name}: send failed: ${e}`));
		};
		const client = new LanguageClient(info.name, write, {
			diagnostics: (uri, kind, items) => {
				this.#origin.set(uri, key);
				this.#setDiagnostics(uri, kind, items);
			},
			status: (s) => this.#setStatus(info, s),
			log: (line) => this.#append(line),
			// MessageType Error 1, Warning 2, Info 3 are notifications (VS Code); Log 4 only goes to the Output log.
			showMessage: (type, message) => {
				if (type <= 3) notifications.notify({ severity: MESSAGE_SEVERITY[type], message, source: info.name });
			},
			showMessageRequest: async (type, message, actions) => (await notifications.prompt(MESSAGE_SEVERITY[type] ?? 'info', message, actions, { source: info.name })) ?? null,
			applyEdit: (edit) => this.applyWorkspaceEdit(edit),
			configuration: (section) => configurationValue(this.#settingsFor(info), section)
		});
		const channel = new Channel<LspEvent>();
		channel.onmessage = (ev) => {
			if (ev.type === 'message') client.rpc.handle(ev.json);
			else if (ev.type === 'stderr') this.#append(ev.line);
			else {
				this.#append(`${info.name} exited (code ${ev.code})`);
				client.exited(ev.code);
				if (this.#sessions.get(key)?.client === client) this.#forget(key);
			}
		};
		const session: Session = { info, client, id: null, ready: Promise.resolve(false) };
		this.#sessions.set(key, session);
		this.#setStatus(info, { state: 'starting' });
		session.ready = (async () => {
			try {
				id = await invoke<number>('lsp_start', { language: info.languages[0], onEvent: channel });
				session.id = id;
				const caps = await client.initialize(uriOfRel(root, '').replace(/\/$/, ''), info.initializationOptions);
				const pushed = this.#settingsFor(info);
				if (Object.keys(pushed).length) client.rpc.notify('workspace/didChangeConfiguration', { settings: pushed });
				clientLog('info', `${info.name} initialized`);
				if (this.#sessions.get(key) === session) this.#registerProviders(info, caps);
				return true;
			} catch (e) {
				const message = String(e);
				this.#setStatus(info, { state: message.includes(NOT_INSTALLED) ? 'not-installed' : 'error', message });
				this.#append(message);
				clientLog('error', `language server ${key}: ${message}`);
				return false;
			}
		})();
		return session;
	}

	async #stop(key: string) {
		const s = this.#sessions.get(key);
		if (!s) return;
		this.#forget(key);
		try {
			await Promise.race([s.client.shutdown(), new Promise((r) => setTimeout(r, 2000))]);
		} catch {
			/* already gone */
		}
		if (s.id !== null) await invoke('lsp_stop', { id: s.id }).catch(() => {});
	}

	/** Drops a session and everything it published (VS Code clears a stopped server's problems). */
	#forget(key: string) {
		this.#sessions.delete(key);
		this.#providers.get(key)?.forEach((d) => d.dispose());
		this.#providers.delete(key);
		for (const uri of this.#index.clear((uri) => this.#origin.get(uri) === key)) {
			this.#origin.delete(uri);
			this.#applyMarkers(uri);
		}
		for (const d of this.#docs.values()) if (d.key === key) d.uri = '';
		this.#queueRefresh();
	}

	#setStatus(info: ServerInfo, s: ServerStatus) {
		this.status.set(info.key, s);
		if (info.yieldsBuiltin && s.state === 'ready') this.#yieldBuiltin(info.key);
	}

	/** Monaco's bundled TypeScript/JSON/CSS/HTML workers would answer hovers, completions and
	 * diagnostics a second time. Colors, folding and selection ranges stay (no LSP equivalent here). */
	#yieldBuiltin(key: string) {
		const m = this.#monaco as unknown as Record<string, Record<string, ModeDefaults | undefined> | undefined> | undefined;
		const defaults: Record<string, (ModeDefaults | undefined)[]> = {
			typescript: [m?.typescript?.typescriptDefaults, m?.typescript?.javascriptDefaults],
			json: [m?.json?.jsonDefaults],
			css: [m?.css?.cssDefaults, m?.css?.scssDefaults, m?.css?.lessDefaults],
			html: [m?.html?.htmlDefaults]
		};
		for (const d of defaults[key] ?? []) {
			d?.setModeConfiguration({
				...d.modeConfiguration,
				completionItems: false,
				hovers: false,
				definitions: false,
				diagnostics: false,
				documentSymbols: false,
				references: false,
				documentHighlights: false,
				rename: false,
				signatureHelp: false,
				// TypeScript keeps Monaco's whole-document formatting, as before; the servers format JSON/CSS/HTML.
				...(key === 'typescript' ? {} : { documentFormattingEdits: false, links: false }),
				documentRangeFormattingEdits: false,
				onTypeFormattingEdits: false,
				codeActions: false
			});
		}
	}

	/** `workspace/configuration` answers and pushed settings: the table's, plus Kingu's
	 * settings.json schema for the JSON server (Monaco's JSON worker has it too), then `settings`. */
	#settingsFor(info: ServerInfo): Record<string, unknown> {
		const base: Record<string, unknown> = { ...info.settings };
		if (info.key === 'json') {
			const json = base.json as { schemas: unknown[] };
			base.json = { ...json, schemas: [...json.schemas, { fileMatch: ['settings.json', '**/settings.json'], schema: jsonSchema(settingSchemas.all) }] };
		}
		return { ...base, ...this.settings[info.key] };
	}

	#append(line: string) {
		this.#pendingLog.push(line);
		if (this.#pendingLog.length > 1) return;
		queueMicrotask(() => {
			this.log = [...this.log, ...this.#pendingLog].slice(-LOG_LIMIT);
			this.#pendingLog = [];
		});
	}

	// --- Diagnostics -----------------------------------------------------------------------------

	#setDiagnostics(uri: string, kind: 'push' | 'pull', items: Diagnostic[]) {
		this.#index.set(uri, kind, items);
		this.#applyMarkers(uri);
		this.#queueRefresh();
	}

	#applyMarkers(uri: string) {
		const monaco = this.#monaco;
		const rel = relOfUri(this.#rootPath, uri);
		if (!monaco || rel === null) return;
		const model = monaco.editor.getModel(monaco.Uri.file('/' + rel));
		if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, this.#index.get(uri).map(toMarker));
	}

	#queueRefresh() {
		if (this.#refreshQueued) return;
		this.#refreshQueued = true;
		queueMicrotask(() => {
			this.#refreshQueued = false;
			this.problems = this.#index.files(this.#rootPath);
		});
	}

	// --- Symbols (breadcrumbs) -------------------------------------------------------------------

	#scheduleSymbols(doc: Doc, delay = SYMBOLS_DELAY_MS) {
		clearTimeout(this.#symbolTimers.get(doc.rel));
		this.#symbolTimers.set(
			doc.rel,
			setTimeout(async () => {
				const client = this.#sessions.get(doc.key)?.client;
				if (!doc.uri || !client?.ready) return;
				try {
					const syms = await client.documentSymbols(doc.uri);
					if (this.#docs.has(doc.model)) this.symbols.set(doc.rel, syms ?? []);
				} catch {
					/* indexing; the next edit asks again */
				}
			}, delay)
		);
	}

	// --- Monaco providers ------------------------------------------------------------------------

	#lookup(model: Monaco.editor.ITextModel): { client: LanguageClient; uri: string } | null {
		const doc = this.#docs.get(model);
		const client = doc?.uri ? this.#sessions.get(doc.key)?.client : undefined;
		return doc && client?.ready ? { client, uri: doc.uri } : null;
	}

	/** Monaco location of an LSP URI: a workspace file, or an external one Monaco cannot open. */
	#monacoUri(uri: string): Monaco.Uri {
		const monaco = this.#monaco!;
		const rel = relOfUri(this.#rootPath, uri);
		return rel !== null ? monaco.Uri.file('/' + rel) : monaco.Uri.from({ scheme: EXTERNAL_SCHEME, path: uriToPath(uri) ?? uri });
	}

	/** Peek widgets need a model for every file they show; create read-only previews for files
	 * with no tab (EditorHost adopts one through `adoptPreview` when the file is opened). */
	async #ensurePreviews(rels: string[], { dropOthers = false } = {}) {
		const monaco = this.#monaco!;
		const want = new Set(rels);
		if (dropOthers) for (const [rel, model] of this.#previews) if (!want.has(rel)) this.#dropPreview(rel, model);
		const missing = [...want].filter((rel) => !monaco.editor.getModel(monaco.Uri.file('/' + rel)));
		if (!missing.length) return;
		const { languageFor } = await import('#lib/editor/monaco.ts');
		await Promise.all(
			missing.map(async (rel) => {
				const text = await invoke<string>('read_workspace_file', { rel }).catch(() => null);
				const uri = monaco.Uri.file('/' + rel);
				if (text === null || monaco.editor.getModel(uri)) return;
				this.#previews.set(rel, monaco.editor.createModel(text, languageFor(rel), uri));
			})
		);
	}

	#dropPreview(rel: string, model = this.#previews.get(rel)) {
		this.#previews.delete(rel);
		if (model && !model.isDisposed()) model.dispose();
	}

	/** EditorHost takes over a preview model when its file is opened in a tab. */
	adoptPreview(rel: string): Monaco.editor.ITextModel | null {
		const model = this.#previews.get(rel);
		this.#previews.delete(rel);
		return model && !model.isDisposed() ? model : null;
	}

	/** Applies a WorkspaceEdit (rename, code actions, `workspace/applyEdit`): files open in an editor
	 * are edited in their model (undoable, left dirty), others are rewritten on disk through the
	 * workspace-guarded Rust commands. Nothing outside the workspace is touched. */
	async applyWorkspaceEdit(edit: WorkspaceEdit): Promise<ApplyResult> {
		const written: string[] = [];
		const result = await applyWorkspaceEdit(edit, (uri) => {
			const rel = relOfUri(this.#rootPath, uri);
			if (rel === null) return `${uriToPath(uri) ?? uri} is outside the workspace`;
			const model = editors.textModel(rel);
			if (model) {
				const doc = this.#docs.get(model);
				return {
					version: doc?.uri === uri ? this.#sessions.get(doc.key)?.client.versionOf(uri) : undefined,
					read: () => model.getValue(),
					commit: (text, edits) => {
						const ops = edits ? toMonacoTextEdits(edits) : [{ range: model.getFullModelRange(), text }];
						model.pushStackElement();
						model.pushEditOperations([], ops.map((e) => ({ range: e.range, text: e.text, forceMoveMarkers: true })), () => null);
						model.pushStackElement();
					}
				};
			}
			return {
				read: () => invoke<string>('read_workspace_file', { rel }),
				commit: async (text) => {
					await invoke('fs_write_file', { rel, content: text });
					written.push(uri);
					this.#dropPreview(rel);
				}
			};
		});
		if (written.length) for (const s of this.#sessions.values()) s.client.didChangeWatchedFiles(written);
		if (!result.applied) this.#append(`workspace edit not applied: ${result.failureReason}`);
		return result;
	}

	/** `editor.codeActionsOnSave` (VS Code's CodeActionOnSaveParticipant): code actions of each kind
	 * over the whole file, applied in order. Without a server for the file this does nothing. */
	async codeActionsOnSave(model: Monaco.editor.ITextModel, kinds: string[]) {
		const doc = this.#docs.get(model);
		const d = this.#lookup(model);
		if (!doc || !d || !kinds.length) return;
		const markers = this.#monaco?.editor.getModelMarkers({ resource: model.uri, owner: MARKER_OWNER }) ?? [];
		for (const kind of kinds) {
			// triggerKind 2: Automatic, so servers only offer actions safe to apply unattended.
			const context = { diagnostics: markers.map(markerToDiagnostic), only: [kind], triggerKind: 2 };
			const items = await d.client.codeActions(d.uri, toLspRange(model.getFullModelRange()), context).catch(() => null);
			for (const item of items ?? []) {
				const k = typeof item.command === 'string' ? undefined : (item as CodeAction).kind;
				if (k && k !== kind && !k.startsWith(`${kind}.`)) continue;
				if ((item as CodeAction).disabled) continue;
				await this.#runCodeAction(doc.key, item);
			}
		}
	}

	async #runCodeAction(key: string, item: Command | CodeAction) {
		const client = this.#sessions.get(key)?.client;
		if (!client?.ready) return;
		try {
			if (typeof item.command === 'string') return void (await this.#execute(client, item as Command));
			let action = item as CodeAction;
			if (!action.edit && client.canResolveCodeAction) action = (await client.resolveCodeAction(action)) ?? action;
			if (action.edit) {
				const r = await this.applyWorkspaceEdit(action.edit);
				if (!r.applied) return statusBar.error(`${action.title}: ${r.failureReason}`);
			}
			if (action.command) await this.#execute(client, action.command);
		} catch (e) {
			notifications.error(`${item.title}: ${e instanceof Error ? e.message : e}`);
		}
	}

	async #execute(client: LanguageClient, command: Command) {
		if (!(await client.executeCommand(command))) statusBar.flash(`${command.title || command.command}: not supported by the server`);
	}

	#registerProviders(info: ServerInfo, caps: ServerCapabilities) {
		const monaco = this.#monaco!;
		this.#providers.get(info.key)?.forEach((d) => d.dispose());
		const disposables: Monaco.IDisposable[] = [];
		this.#providers.set(info.key, disposables);
		const add = (d: Monaco.IDisposable) => disposables.push(d);
		const resolved = new WeakMap<Monaco.languages.CompletionItem, { client: LanguageClient; item: CompletionItem }>();
		const word = (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
			const w = model.getWordAtPosition(position);
			return w ? { range: { startLineNumber: position.lineNumber, startColumn: w.startColumn, endLineNumber: position.lineNumber, endColumn: w.endColumn }, text: w.word } : null;
		};

		for (const language of info.languages) {
			if (caps.hoverProvider)
				add(
					monaco.languages.registerHoverProvider(language, {
						provideHover: async (model, position, token) => {
							const d = this.#lookup(model);
							const hover = d && (await d.client.hover(d.uri, toLspPosition(position), token).catch(() => null));
							return hover ? { contents: hoverContents(hover), range: hover.range && toMonacoRange(hover.range) } : null;
						}
					})
				);

			if (caps.completionProvider)
				add(
					monaco.languages.registerCompletionItemProvider(language, {
						triggerCharacters: caps.completionProvider.triggerCharacters ?? [],
						provideCompletionItems: async (model, position, context, token) => {
							const d = this.#lookup(model);
							if (!d) return { suggestions: [] };
							const lspContext = { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter };
							const result = await d.client.completion(d.uri, toLspPosition(position), lspContext, token).catch(() => null);
							if (!result) return { suggestions: [] };
							const w = model.getWordUntilPosition(position);
							const fallback = { startLineNumber: position.lineNumber, startColumn: w.startColumn, endLineNumber: position.lineNumber, endColumn: w.endColumn };
							const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result;
							const suggestions = list.items.map((item) => {
								const s = toCompletionItem(item, fallback, list.itemDefaults);
								resolved.set(s, { client: d.client, item: list.itemDefaults?.data !== undefined && item.data === undefined ? { ...item, data: list.itemDefaults.data } : item });
								return s;
							});
							return { suggestions, incomplete: list.isIncomplete };
						},
						resolveCompletionItem: async (suggestion, token) => {
							const r = resolved.get(suggestion);
							if (!r?.client.capabilities.completionProvider?.resolveProvider) return suggestion;
							const item = await r.client.resolveCompletion(r.item, token).catch(() => null);
							if (!item) return suggestion;
							const range = suggestion.range;
							const full = toCompletionItem(item, 'insert' in range ? range.replace : range);
							// Keep what Monaco already placed; take the fields resolve exists to fill in.
							return { ...suggestion, detail: full.detail ?? suggestion.detail, documentation: full.documentation ?? suggestion.documentation, additionalTextEdits: full.additionalTextEdits ?? suggestion.additionalTextEdits };
						}
					})
				);

			if (caps.definitionProvider)
				add(
					monaco.languages.registerDefinitionProvider(language, {
						provideDefinition: async (model, position, token) => {
							const d = this.#lookup(model);
							const result = d && (await d.client.definition(d.uri, toLspPosition(position), token).catch(() => null));
							const targets = toTargets(result);
							await this.#ensurePreviews(targets.map((t) => relOfUri(this.#rootPath, t.uri)).filter((r) => r !== null));
							return targets.map((t) => ({ uri: this.#monacoUri(t.uri), range: toMonacoRange(t.range) }));
						}
					})
				);

			if (caps.referencesProvider)
				add(
					monaco.languages.registerReferenceProvider(language, {
						provideReferences: async (model, position, context, token) => {
							const d = this.#lookup(model);
							const result = d && (await d.client.references(d.uri, toLspPosition(position), context.includeDeclaration, token).catch(() => null));
							// The peek can only show workspace files (it needs a model for each).
							const inside = (result ?? []).filter((l) => relOfUri(this.#rootPath, l.uri) !== null);
							await this.#ensurePreviews(
								inside.map((l) => relOfUri(this.#rootPath, l.uri)!),
								{ dropOthers: true }
							);
							return inside.map((l) => ({ uri: this.#monacoUri(l.uri), range: toMonacoRange(l.range) }));
						}
					})
				);

			if (caps.documentHighlightProvider)
				add(
					monaco.languages.registerDocumentHighlightProvider(language, {
						provideDocumentHighlights: async (model, position, token) => {
							const d = this.#lookup(model);
							return toDocumentHighlights(d && (await d.client.documentHighlight(d.uri, toLspPosition(position), token).catch(() => null)));
						}
					})
				);

			if (caps.documentSymbolProvider)
				add(
					monaco.languages.registerDocumentSymbolProvider(language, {
						displayName: info.name,
						provideDocumentSymbols: async (model, token) => {
							const d = this.#lookup(model);
							const syms = d && (await d.client.documentSymbols(d.uri, token).catch(() => null));
							return syms ? toMonacoSymbols(syms) : [];
						}
					})
				);

			if (caps.signatureHelpProvider)
				add(
					monaco.languages.registerSignatureHelpProvider(language, {
						signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? [],
						signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters ?? [],
						provideSignatureHelp: async (model, position, token, context) => {
							const d = this.#lookup(model);
							if (!d) return null;
							const lspContext = {
								triggerKind: context.triggerKind,
								triggerCharacter: context.triggerCharacter,
								isRetrigger: context.isRetrigger,
								activeSignatureHelp: context.activeSignatureHelp && fromSignatureHelp(context.activeSignatureHelp)
							};
							const help = await d.client.signatureHelp(d.uri, toLspPosition(position), lspContext, token).catch(() => null);
							return help?.signatures?.length ? { value: toSignatureHelp(help), dispose() {} } : null;
						}
					})
				);

			if (caps.renameProvider)
				add(
					monaco.languages.registerRenameProvider(language, {
						resolveRenameLocation: async (model, position, token) => {
							const d = this.#lookup(model);
							const fallback = word(model, position);
							const reject = (rejectReason: string) => ({ range: fallback?.range ?? toMonacoRange({ start: toLspPosition(position), end: toLspPosition(position) }), text: '', rejectReason });
							if (!d) return reject(`${info.name} is not ready`);
							let prepared;
							if (d.client.canPrepareRename) {
								try {
									prepared = await d.client.prepareRename(d.uri, toLspPosition(position), token);
								} catch (e) {
									return reject(e instanceof Error ? e.message : String(e));
								}
							}
							return toRenameLocation(prepared, fallback, (r) => model.getValueInRange(r)) ?? reject("The element can't be renamed.");
						},
						provideRenameEdits: async (model, position, newName, token) => {
							const d = this.#lookup(model);
							if (!d) return { edits: [], rejectReason: `${info.name} is not ready` };
							let edit: WorkspaceEdit | null;
							try {
								edit = await d.client.rename(d.uri, toLspPosition(position), newName, token);
							} catch (e) {
								return { edits: [], rejectReason: e instanceof Error ? e.message : String(e) };
							}
							if (!edit) return { edits: [], rejectReason: 'No result.' };
							// Applied here rather than by Monaco, whose standalone bulk edit only reaches
							// open models; files without a tab are rewritten on disk.
							const r = await this.applyWorkspaceEdit(edit);
							if (!r.applied) return { edits: [], rejectReason: `Rename failed: ${r.failureReason}` };
							statusBar.flash(`Renamed to '${newName}': ${r.edits} edits in ${r.uris.length} ${r.uris.length === 1 ? 'file' : 'files'}`);
							return { edits: [] };
						}
					})
				);

			if (caps.codeActionProvider) {
				const kinds = typeof caps.codeActionProvider === 'object' ? caps.codeActionProvider.codeActionKinds : undefined;
				add(
					monaco.languages.registerCodeActionProvider(
						language,
						{
							provideCodeActions: async (model, range, context, token) => {
								const d = this.#lookup(model);
								const none = { actions: [], dispose() {} };
								if (!d) return none;
								const lspContext = { diagnostics: context.markers.map(markerToDiagnostic), only: context.only ? [context.only] : undefined, triggerKind: context.trigger };
								const items = await d.client.codeActions(d.uri, toLspRange(range), lspContext, token).catch(() => null);
								if (!items?.length) return none;
								const actions = items.map((item): Monaco.languages.CodeAction => {
									const run = { id: CODE_ACTION_COMMAND, title: item.title, arguments: [info.key, item] };
									if (typeof item.command === 'string') return { title: item.title, command: run };
									const a = item as CodeAction;
									return {
										title: a.title,
										kind: a.kind,
										isPreferred: a.isPreferred,
										disabled: a.disabled?.reason,
										diagnostics: a.diagnostics?.map((x) => toMarker(x)),
										command: run
									};
								});
								return { actions, dispose() {} };
							}
						},
						kinds ? { providedCodeActionKinds: kinds } : undefined
					)
				);
			}

			if (caps.documentFormattingProvider)
				add(
					monaco.languages.registerDocumentFormattingEditProvider(language, {
						displayName: info.name,
						provideDocumentFormattingEdits: async (model, options, token) => {
							const d = this.#lookup(model);
							const fmt = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
							return toMonacoTextEdits(d && (await d.client.formatting(d.uri, fmt, token).catch((e) => (notifications.error(`Format: ${e}`), null))));
						}
					})
				);

			if (caps.documentRangeFormattingProvider)
				add(
					monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
						displayName: info.name,
						provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
							const d = this.#lookup(model);
							const fmt = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
							return toMonacoTextEdits(d && (await d.client.rangeFormatting(d.uri, toLspRange(range), fmt, token).catch((e) => (notifications.error(`Format: ${e}`), null))));
						}
					})
				);
		}
	}
}

type ModeDefaults = { modeConfiguration: object; setModeConfiguration(c: object): void };

export const lsp = new Lsp();
