// One language server session: lifecycle, document sync, progress/status and diagnostics.
// Transport-agnostic (the Tauri bridge lives in lsp.svelte.ts) so it can be tested with a fake.

import { folderChanges, type LspFolder } from './convert';
import { JsonRpc, ResponseError, type Cancellation } from './jsonrpc';
import {
	ErrorCodes,
	type CallHierarchyIncomingCall,
	type CallHierarchyItem,
	type CallHierarchyOutgoingCall,
	type CodeLens,
	type Color,
	type ColorInformation,
	type ColorPresentation,
	type DocumentLink,
	type FoldingRange,
	type InlayHint,
	type LinkedEditingRanges,
	type SelectionRange,
	type SemanticTokens,
	type SemanticTokensDelta,
	type SemanticTokensLegend,
	type TypeHierarchyItem,
	type CodeAction,
	type Command,
	type CompletionItem,
	type CompletionList,
	type Diagnostic,
	type DocumentDiagnosticReport,
	type DocumentHighlight,
	type DocumentSymbol,
	type FormattingOptions,
	type Hover,
	type Location,
	type LocationLink,
	type Position,
	type PrepareRenameResult,
	type ProgressValue,
	type Range,
	type ServerCapabilities,
	type SignatureHelp,
	type SignatureHelpContext,
	type SymbolInformation,
	type TextEdit,
	type WorkspaceEdit
} from './protocol';

export type ServerState = 'starting' | 'indexing' | 'ready' | 'not-installed' | 'error' | 'stopped';
export type ServerStatus = { state: ServerState; message?: string };

export type ClientHooks = {
	/** `kind` keeps pushed and pulled diagnostics apart; the store merges them per file. */
	diagnostics(uri: string, kind: 'push' | 'pull', items: Diagnostic[]): void;
	status(status: ServerStatus): void;
	log(line: string): void;
	showMessage?(type: number, message: string): void;
	/** `window/showMessageRequest`: the chosen action's title, or null when dismissed. */
	showMessageRequest?(type: number, message: string, actions: string[]): Promise<string | null>;
	/** `workspace/applyEdit` from the server (code action commands, refactorings). */
	applyEdit?(edit: WorkspaceEdit, label?: string): Promise<{ applied: boolean; failureReason?: string }>;
	/** `workspace/configuration`: the settings value for `section` (null when unset). */
	configuration?(section: string | undefined, scopeUri: string | undefined): unknown;
	/** `workspace/semanticTokens/refresh`, `workspace/inlayHint/refresh`, `workspace/codeLens/refresh`. */
	refresh?(kind: RefreshKind): void;
};

/** LSP's predefined semantic token types and modifiers (the ones VS Code's theming knows). */
export const SEMANTIC_TOKEN_TYPES = [
	'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event',
	'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator', 'label'
];
export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'];

/** Server → client refresh requests (LSP 3.16/3.17) that re-ask a feature for every open file. */
export type RefreshKind = 'semanticTokens' | 'inlayHint' | 'codeLens';

/** Code action kinds Kingu understands (VS Code's list). */
const CODE_ACTION_KINDS = ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'];

export const clientCapabilities = {
	general: { positionEncodings: ['utf-16'] },
	window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: false } } },
	workspace: {
		workspaceFolders: true,
		configuration: true,
		symbol: { dynamicRegistration: false },
		applyEdit: true,
		workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: 'abort', normalizesLineEndings: false },
		executeCommand: { dynamicRegistration: false },
		diagnostics: { refreshSupport: true },
		semanticTokens: { refreshSupport: true },
		inlayHint: { refreshSupport: true },
		codeLens: { refreshSupport: true },
		didChangeConfiguration: { dynamicRegistration: false },
		// Update imports on file move (typescript-language-server's willRenameFiles).
		fileOperations: { dynamicRegistration: false, willRename: true, didRename: true }
	},
	textDocument: {
		synchronization: { didSave: true, willSave: false, willSaveWaitUntil: false, dynamicRegistration: false },
		publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] }, versionSupport: true, codeDescriptionSupport: true },
		diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
		hover: { contentFormat: ['markdown', 'plaintext'] },
		completion: {
			contextSupport: true,
			completionItem: {
				snippetSupport: true,
				commitCharactersSupport: true,
				documentationFormat: ['markdown', 'plaintext'],
				deprecatedSupport: true,
				preselectSupport: true,
				tagSupport: { valueSet: [1] },
				insertReplaceSupport: true,
				labelDetailsSupport: true,
				resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
			},
			completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'data'] }
		},
		definition: { linkSupport: true },
		documentSymbol: { hierarchicalDocumentSymbolSupport: true },
		references: {},
		documentHighlight: {},
		rename: { prepareSupport: true, prepareSupportDefaultBehavior: 1, honorsChangeAnnotations: false },
		codeAction: {
			codeActionLiteralSupport: { codeActionKind: { valueSet: CODE_ACTION_KINDS } },
			isPreferredSupport: true,
			disabledSupport: true,
			dataSupport: true,
			resolveSupport: { properties: ['edit'] }
		},
		signatureHelp: {
			contextSupport: true,
			signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }
		},
		formatting: {},
		rangeFormatting: {},
		onTypeFormatting: {},
		declaration: { linkSupport: true },
		typeDefinition: { linkSupport: true },
		implementation: { linkSupport: true },
		inlayHint: { resolveSupport: { properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'] } },
		semanticTokens: {
			requests: { range: true, full: { delta: true } },
			tokenTypes: SEMANTIC_TOKEN_TYPES,
			tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
			formats: ['relative'],
			overlappingTokenSupport: false,
			multilineTokenSupport: false,
			serverCancelSupport: true,
			augmentsSyntaxTokens: true
		},
		// VS Code: editor.foldingMaximumRegions, line folding only (Monaco folds whole lines).
		foldingRange: { rangeLimit: 5000, lineFoldingOnly: true, foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] } },
		codeLens: {},
		callHierarchy: {},
		typeHierarchy: {},
		linkedEditingRange: {},
		selectionRange: {},
		documentLink: { tooltipSupport: true },
		colorProvider: {}
	},
	// rust-analyzer: `experimental/serverStatus` tells when indexing is done; its code lenses use
	// these client commands (references open Monaco's peek, see featureProviders.ts).
	experimental: { serverStatusNotification: true, commands: { commands: ['rust-analyzer.showReferences', 'rust-analyzer.gotoLocation'] } }
};

type Doc = { languageId: string; version: number; text: string };

const PULL_DELAY_MS = 250;

export class LanguageClient {
	readonly rpc: JsonRpc;
	capabilities: ServerCapabilities = {};
	readonly docs = new Map<string, Doc>();
	readonly #hooks: ClientHooks;
	readonly #name: string;
	#ready = false;
	#progress = new Map<string | number, ProgressValue>();
	/** rust-analyzer's own busy flag (`experimental/serverStatus`), when it sends one. */
	#quiescent = true;
	#pullTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#lastState: ServerState | null = null;
	/** The workspace folders the server knows (`initialize`, then `didChangeWorkspaceFolders`). */
	#folders: LspFolder[] = [];

	constructor(name: string, write: (json: string) => void, hooks: ClientHooks) {
		this.#name = name;
		this.#hooks = hooks;
		this.rpc = new JsonRpc(write);
		const rpc = this.rpc;

		rpc.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Diagnostic[] }) => hooks.diagnostics(p.uri, 'push', p.diagnostics ?? []));
		rpc.onNotification('$/progress', (p: { token: string | number; value: ProgressValue }) => {
			if (!p?.value || typeof p.value !== 'object' || !('kind' in p.value)) return;
			if (p.value.kind === 'end') this.#progress.delete(p.token);
			else this.#progress.set(p.token, { ...this.#progress.get(p.token), ...p.value });
			this.#emitStatus();
		});
		rpc.onNotification('experimental/serverStatus', (p: { health: string; quiescent: boolean; message?: string }) => {
			this.#quiescent = p.quiescent;
			if (p.health === 'error' && p.message) hooks.log(`${name}: ${p.message}`);
			this.#emitStatus();
		});
		rpc.onNotification('window/logMessage', (p: { message: string }) => hooks.log(p.message));
		rpc.onNotification('window/showMessage', (p: { type: number; message: string }) => {
			hooks.log(p.message);
			hooks.showMessage?.(p.type, p.message);
		});

		rpc.onRequest('window/workDoneProgress/create', () => null);
		rpc.onRequest('workspace/configuration', (p: { items: { section?: string; scopeUri?: string }[] }) =>
			(p?.items ?? []).map((item) => hooks.configuration?.(item?.section, item?.scopeUri) ?? null)
		);
		rpc.onRequest('client/registerCapability', () => null);
		rpc.onRequest('client/unregisterCapability', () => null);
		rpc.onRequest('window/showMessageRequest', async (p: { type: number; message: string; actions?: { title: string }[] }) => {
			hooks.log(p.message);
			const actions = (p.actions ?? []).map((a) => a.title);
			if (hooks.showMessageRequest) {
				const title = await hooks.showMessageRequest(p.type, p.message, actions);
				return title === null ? null : { title };
			}
			hooks.showMessage?.(p.type, p.message);
			return null;
		});
		rpc.onRequest('workspace/workspaceFolders', () => (this.#folders.length ? this.#folders : null));
		rpc.onRequest('workspace/diagnostic/refresh', () => (this.#pullAll(), null));
		const refreshes: [string, RefreshKind][] = [
			['workspace/semanticTokens/refresh', 'semanticTokens'],
			['workspace/inlayHint/refresh', 'inlayHint'],
			['workspace/codeLens/refresh', 'codeLens']
		];
		for (const [m, kind] of refreshes) rpc.onRequest(m, () => (hooks.refresh?.(kind), null));
		rpc.onRequest('workspace/inlineValue/refresh', () => null);
		rpc.onRequest('workspace/applyEdit', async (p: { label?: string; edit: WorkspaceEdit }) => {
			if (!hooks.applyEdit) return { applied: false, failureReason: 'no workspace to edit' };
			const r = await hooks.applyEdit(p.edit, p.label);
			return r.applied ? { applied: true } : { applied: false, failureReason: r.failureReason };
		});
	}

	get ready() {
		return this.#ready;
	}

	/** `folders`: every root folder of the workspace (the first is `rootUri`); just `rootUri` when omitted. */
	async initialize(rootUri: string, initializationOptions?: unknown, trace: 'off' | 'messages' | 'verbose' = 'off', folders?: LspFolder[]): Promise<ServerCapabilities> {
		this.#folders = folders?.length ? folders : [{ uri: rootUri, name: rootUri.split('/').pop() ?? 'workspace' }];
		this.#hooks.status({ state: 'starting' });
		const result = await this.rpc.request<{ capabilities: ServerCapabilities }>('initialize', {
			processId: null,
			clientInfo: { name: 'Kingu' },
			locale: 'en',
			rootUri,
			rootPath: decodeURIComponent(rootUri.replace(/^file:\/\//, '')),
			workspaceFolders: this.#folders,
			capabilities: clientCapabilities,
			initializationOptions,
			trace
		});
		this.capabilities = result?.capabilities ?? {};
		this.rpc.notify('initialized', {});
		this.#ready = true;
		this.#emitStatus();
		return this.capabilities;
	}

	/** Whether the server works with several workspace folders at once (else it only knows `rootUri`). */
	get takesFolders(): boolean {
		return !!this.capabilities.workspace?.workspaceFolders?.supported;
	}

	/** Whether the server takes `workspace/didChangeWorkspaceFolders` (else it must restart to see new folders). */
	get takesFolderChanges(): boolean {
		return !!this.capabilities.workspace?.workspaceFolders?.changeNotifications;
	}

	/** Tells the server the workspace folders are now `next`; false when nothing changed. */
	changeWorkspaceFolders(next: LspFolder[]): boolean {
		const event = folderChanges(this.#folders, next);
		this.#folders = next;
		if (!event.added.length && !event.removed.length) return false;
		if (this.#ready) this.rpc.notify('workspace/didChangeWorkspaceFolders', { event });
		return true;
	}

	/** The server process ended (crash, kill, or after `exit`). */
	exited(code: number | null) {
		this.#ready = false;
		this.rpc.close(`${this.#name} exited`);
		this.#pullTimers.forEach(clearTimeout);
		this.#hooks.status({ state: code === 0 || code === null ? 'stopped' : 'error', message: code ? `exited with code ${code}` : undefined });
	}

	async shutdown() {
		if (!this.#ready) return;
		try {
			await this.rpc.request('shutdown');
		} finally {
			this.rpc.notify('exit');
			this.#ready = false;
		}
	}

	// --- Status ----------------------------------------------------------------------------------

	get busy() {
		return this.#progress.size > 0 || !this.#quiescent;
	}

	#emitStatus() {
		if (!this.#ready) return;
		const latest = [...this.#progress.values()].pop();
		const state: ServerState = this.busy ? 'indexing' : 'ready';
		let message: string | undefined;
		if (latest) {
			message = [latest.title, latest.message].filter(Boolean).join(': ');
			if (latest.percentage !== undefined && !latest.message?.includes('%')) message += ` (${latest.percentage}%)`;
		}
		// Busy → idle is when rust-analyzer can answer diagnostic pulls it refused while loading.
		if (state === 'ready' && this.#lastState === 'indexing') this.#pullAll();
		this.#lastState = state;
		this.#hooks.status({ state, message });
	}

	// --- Documents -------------------------------------------------------------------------------

	get #syncKind(): number {
		const s = this.capabilities.textDocumentSync;
		return typeof s === 'number' ? s : (s?.change ?? 0);
	}

	get #openClose(): boolean {
		const s = this.capabilities.textDocumentSync;
		return typeof s === 'number' ? s > 0 : (s?.openClose ?? false);
	}

	didOpen(uri: string, languageId: string, text: string) {
		if (this.docs.has(uri)) return;
		const doc = { languageId, version: 1, text };
		this.docs.set(uri, doc);
		if (!this.#openClose) return;
		this.rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: doc.version, text } });
		this.#schedulePull(uri);
	}

	/** Full-document sync: a content change without a range replaces the whole text, which
	 * servers accept for both Full and Incremental sync kinds. */
	didChange(uri: string, text: string) {
		const doc = this.docs.get(uri);
		if (!doc) return;
		doc.version++;
		doc.text = text;
		if (this.#syncKind === 0) return;
		this.rpc.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
		this.#schedulePull(uri);
	}

	didSave(uri: string) {
		const doc = this.docs.get(uri);
		if (!doc) return;
		const save = this.capabilities.textDocumentSync;
		const includeText = typeof save === 'object' && typeof save.save === 'object' && save.save.includeText;
		this.rpc.notify('textDocument/didSave', { textDocument: { uri }, text: includeText ? doc.text : undefined });
	}

	didClose(uri: string) {
		if (!this.docs.delete(uri)) return;
		clearTimeout(this.#pullTimers.get(uri));
		this.#pullTimers.delete(uri);
		if (this.#openClose) this.rpc.notify('textDocument/didClose', { textDocument: { uri } });
		// Pulled diagnostics belong to the open document; pushed ones stay until the server clears them.
		this.#hooks.diagnostics(uri, 'pull', []);
	}

	// --- Pull diagnostics (LSP 3.17) -------------------------------------------------------------

	#schedulePull(uri: string) {
		if (!this.capabilities.diagnosticProvider) return;
		clearTimeout(this.#pullTimers.get(uri));
		this.#pullTimers.set(
			uri,
			setTimeout(() => {
				this.#pullTimers.delete(uri);
				void this.pullDiagnostics(uri);
			}, PULL_DELAY_MS)
		);
	}

	#pullAll() {
		for (const uri of this.docs.keys()) this.#schedulePull(uri);
	}

	async pullDiagnostics(uri: string) {
		const doc = this.docs.get(uri);
		if (!doc || !this.capabilities.diagnosticProvider) return;
		const version = doc.version;
		try {
			const report = await this.rpc.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri } });
			if (this.docs.get(uri)?.version !== version) return; // stale; a newer pull is scheduled
			if (report?.kind === 'full') this.#hooks.diagnostics(uri, 'pull', report.items ?? []);
		} catch (e) {
			// ServerCancelled / ContentModified while indexing: retried when the server goes idle.
			if (e instanceof ResponseError && (e.code === ErrorCodes.ServerCancelled || e.code === ErrorCodes.ContentModified)) return;
			this.#hooks.log(`${this.#name}: diagnostic pull failed: ${e}`);
		}
	}

	// --- Language features -----------------------------------------------------------------------

	hover(uri: string, position: Position, token?: Cancellation) {
		if (!this.capabilities.hoverProvider) return Promise.resolve(null);
		return this.rpc.request<Hover | null>('textDocument/hover', { textDocument: { uri }, position }, token);
	}

	completion(uri: string, position: Position, context: { triggerKind: number; triggerCharacter?: string }, token?: Cancellation) {
		if (!this.capabilities.completionProvider) return Promise.resolve(null);
		return this.rpc.request<CompletionItem[] | CompletionList | null>('textDocument/completion', { textDocument: { uri }, position, context }, token);
	}

	resolveCompletion(item: CompletionItem, token?: Cancellation) {
		if (!this.capabilities.completionProvider?.resolveProvider) return Promise.resolve(item);
		return this.rpc.request<CompletionItem>('completionItem/resolve', item, token);
	}

	definition(uri: string, position: Position, token?: Cancellation) {
		if (!this.capabilities.definitionProvider) return Promise.resolve(null);
		return this.rpc.request<Location | Location[] | LocationLink[] | null>('textDocument/definition', { textDocument: { uri }, position }, token);
	}

	documentSymbols(uri: string, token?: Cancellation) {
		if (!this.capabilities.documentSymbolProvider) return Promise.resolve(null);
		return this.rpc.request<DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', { textDocument: { uri } }, token);
	}

	/** `workspace/symbol` (VS Code's `#` quick access). */
	workspaceSymbols(query: string, token?: Cancellation) {
		if (!this.capabilities.workspaceSymbolProvider) return Promise.resolve(null);
		return this.rpc.request<SymbolInformation[] | null>('workspace/symbol', { query }, token);
	}

	references(uri: string, position: Position, includeDeclaration: boolean, token?: Cancellation) {
		if (!this.capabilities.referencesProvider) return Promise.resolve(null);
		return this.rpc.request<Location[] | null>('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration } }, token);
	}

	documentHighlight(uri: string, position: Position, token?: Cancellation) {
		if (!this.capabilities.documentHighlightProvider) return Promise.resolve(null);
		return this.rpc.request<DocumentHighlight[] | null>('textDocument/documentHighlight', { textDocument: { uri }, position }, token);
	}

	signatureHelp(uri: string, position: Position, context: SignatureHelpContext, token?: Cancellation) {
		if (!this.capabilities.signatureHelpProvider) return Promise.resolve(null);
		return this.rpc.request<SignatureHelp | null>('textDocument/signatureHelp', { textDocument: { uri }, position, context }, token);
	}

	get canPrepareRename() {
		const r = this.capabilities.renameProvider;
		return typeof r === 'object' && r !== null && !!r.prepareProvider;
	}

	prepareRename(uri: string, position: Position, token?: Cancellation) {
		return this.rpc.request<PrepareRenameResult>('textDocument/prepareRename', { textDocument: { uri }, position }, token);
	}

	rename(uri: string, position: Position, newName: string, token?: Cancellation) {
		if (!this.capabilities.renameProvider) return Promise.resolve(null);
		return this.rpc.request<WorkspaceEdit | null>('textDocument/rename', { textDocument: { uri }, position, newName }, token);
	}

	codeActions(uri: string, range: Range, context: { diagnostics: Diagnostic[]; only?: string[]; triggerKind: number }, token?: Cancellation) {
		if (!this.capabilities.codeActionProvider) return Promise.resolve(null);
		return this.rpc.request<(Command | CodeAction)[] | null>('textDocument/codeAction', { textDocument: { uri }, range, context }, token);
	}

	get canResolveCodeAction() {
		const c = this.capabilities.codeActionProvider;
		return typeof c === 'object' && c !== null && !!c.resolveProvider;
	}

	resolveCodeAction(action: CodeAction) {
		return this.rpc.request<CodeAction>('codeAction/resolve', action);
	}

	formatting(uri: string, options: FormattingOptions, token?: Cancellation) {
		if (!this.capabilities.documentFormattingProvider) return Promise.resolve(null);
		return this.rpc.request<TextEdit[] | null>('textDocument/formatting', { textDocument: { uri }, options }, token);
	}

	rangeFormatting(uri: string, range: Range, options: FormattingOptions, token?: Cancellation) {
		if (!this.capabilities.documentRangeFormattingProvider) return Promise.resolve(null);
		return this.rpc.request<TextEdit[] | null>('textDocument/rangeFormatting', { textDocument: { uri }, range, options }, token);
	}

	onTypeFormatting(uri: string, position: Position, ch: string, options: FormattingOptions, token?: Cancellation) {
		if (!this.capabilities.documentOnTypeFormattingProvider) return Promise.resolve(null);
		return this.rpc.request<TextEdit[] | null>('textDocument/onTypeFormatting', { textDocument: { uri }, position, ch, options }, token);
	}

	// --- Go to declaration / type definition / implementation ------------------------------------

	#locations(method: string, cap: unknown, uri: string, position: Position, token?: Cancellation) {
		if (!cap) return Promise.resolve(null);
		return this.rpc.request<Location | Location[] | LocationLink[] | null>(method, { textDocument: { uri }, position }, token);
	}

	declaration(uri: string, position: Position, token?: Cancellation) {
		return this.#locations('textDocument/declaration', this.capabilities.declarationProvider, uri, position, token);
	}

	typeDefinition(uri: string, position: Position, token?: Cancellation) {
		return this.#locations('textDocument/typeDefinition', this.capabilities.typeDefinitionProvider, uri, position, token);
	}

	implementation(uri: string, position: Position, token?: Cancellation) {
		return this.#locations('textDocument/implementation', this.capabilities.implementationProvider, uri, position, token);
	}

	// --- Inlay hints, semantic tokens, folding, code lens ----------------------------------------

	inlayHints(uri: string, range: Range, token?: Cancellation) {
		if (!this.capabilities.inlayHintProvider) return Promise.resolve(null);
		return this.rpc.request<InlayHint[] | null>('textDocument/inlayHint', { textDocument: { uri }, range }, token);
	}

	get canResolveInlayHint() {
		const c = this.capabilities.inlayHintProvider;
		return typeof c === 'object' && c !== null && !!c.resolveProvider;
	}

	resolveInlayHint(hint: InlayHint, token?: Cancellation) {
		return this.rpc.request<InlayHint>('inlayHint/resolve', hint, token);
	}

	/** The server's semantic token legend, or null without semantic tokens. */
	get semanticTokensLegend(): SemanticTokensLegend | null {
		return this.capabilities.semanticTokensProvider?.legend ?? null;
	}

	get semanticTokensFull(): boolean {
		return !!this.capabilities.semanticTokensProvider?.full;
	}

	get semanticTokensDelta(): boolean {
		const full = this.capabilities.semanticTokensProvider?.full;
		return typeof full === 'object' && full !== null && !!full.delta;
	}

	get semanticTokensRange(): boolean {
		return !!this.capabilities.semanticTokensProvider?.range;
	}

	semanticTokens(uri: string, token?: Cancellation) {
		if (!this.semanticTokensFull) return Promise.resolve(null);
		return this.rpc.request<SemanticTokens | null>('textDocument/semanticTokens/full', { textDocument: { uri } }, token);
	}

	/** `full/delta` against `previousResultId`; the answer may be a whole new token set. */
	semanticTokensEdits(uri: string, previousResultId: string, token?: Cancellation) {
		if (!this.semanticTokensDelta) return Promise.resolve(null);
		return this.rpc.request<SemanticTokens | SemanticTokensDelta | null>('textDocument/semanticTokens/full/delta', { textDocument: { uri }, previousResultId }, token);
	}

	semanticTokensInRange(uri: string, range: Range, token?: Cancellation) {
		if (!this.semanticTokensRange) return Promise.resolve(null);
		return this.rpc.request<SemanticTokens | null>('textDocument/semanticTokens/range', { textDocument: { uri }, range }, token);
	}

	foldingRanges(uri: string, token?: Cancellation) {
		if (!this.capabilities.foldingRangeProvider) return Promise.resolve(null);
		return this.rpc.request<FoldingRange[] | null>('textDocument/foldingRange', { textDocument: { uri } }, token);
	}

	codeLenses(uri: string, token?: Cancellation) {
		if (!this.capabilities.codeLensProvider) return Promise.resolve(null);
		return this.rpc.request<CodeLens[] | null>('textDocument/codeLens', { textDocument: { uri } }, token);
	}

	get canResolveCodeLens() {
		return !!this.capabilities.codeLensProvider?.resolveProvider;
	}

	resolveCodeLens(lens: CodeLens, token?: Cancellation) {
		return this.rpc.request<CodeLens>('codeLens/resolve', lens, token);
	}

	// --- Call and type hierarchy -----------------------------------------------------------------

	prepareCallHierarchy(uri: string, position: Position, token?: Cancellation) {
		if (!this.capabilities.callHierarchyProvider) return Promise.resolve(null);
		return this.rpc.request<CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', { textDocument: { uri }, position }, token);
	}

	incomingCalls(item: CallHierarchyItem, token?: Cancellation) {
		return this.rpc.request<CallHierarchyIncomingCall[] | null>('callHierarchy/incomingCalls', { item }, token);
	}

	outgoingCalls(item: CallHierarchyItem, token?: Cancellation) {
		return this.rpc.request<CallHierarchyOutgoingCall[] | null>('callHierarchy/outgoingCalls', { item }, token);
	}

	prepareTypeHierarchy(uri: string, position: Position, token?: Cancellation) {
		if (!this.capabilities.typeHierarchyProvider) return Promise.resolve(null);
		return this.rpc.request<TypeHierarchyItem[] | null>('textDocument/prepareTypeHierarchy', { textDocument: { uri }, position }, token);
	}

	supertypes(item: TypeHierarchyItem, token?: Cancellation) {
		return this.rpc.request<TypeHierarchyItem[] | null>('typeHierarchy/supertypes', { item }, token);
	}

	subtypes(item: TypeHierarchyItem, token?: Cancellation) {
		return this.rpc.request<TypeHierarchyItem[] | null>('typeHierarchy/subtypes', { item }, token);
	}

	// --- Linked editing, selection ranges, links, colors -----------------------------------------

	linkedEditingRange(uri: string, position: Position, token?: Cancellation) {
		if (!this.capabilities.linkedEditingRangeProvider) return Promise.resolve(null);
		return this.rpc.request<LinkedEditingRanges | null>('textDocument/linkedEditingRange', { textDocument: { uri }, position }, token);
	}

	selectionRanges(uri: string, positions: Position[], token?: Cancellation) {
		if (!this.capabilities.selectionRangeProvider) return Promise.resolve(null);
		return this.rpc.request<SelectionRange[] | null>('textDocument/selectionRange', { textDocument: { uri }, positions }, token);
	}

	documentLinks(uri: string, token?: Cancellation) {
		if (!this.capabilities.documentLinkProvider) return Promise.resolve(null);
		return this.rpc.request<DocumentLink[] | null>('textDocument/documentLink', { textDocument: { uri } }, token);
	}

	get canResolveDocumentLink() {
		return !!this.capabilities.documentLinkProvider?.resolveProvider;
	}

	resolveDocumentLink(link: DocumentLink, token?: Cancellation) {
		return this.rpc.request<DocumentLink>('documentLink/resolve', link, token);
	}

	documentColors(uri: string, token?: Cancellation) {
		if (!this.capabilities.colorProvider) return Promise.resolve(null);
		return this.rpc.request<ColorInformation[] | null>('textDocument/documentColor', { textDocument: { uri } }, token);
	}

	colorPresentations(uri: string, color: Color, range: Range, token?: Cancellation) {
		if (!this.capabilities.colorProvider) return Promise.resolve(null);
		return this.rpc.request<ColorPresentation[] | null>('textDocument/colorPresentation', { textDocument: { uri }, color, range }, token);
	}

	/** Pushes settings (VS Code's language clients send their `synchronize.configurationSection`). */
	didChangeConfiguration(settings: unknown) {
		if (this.#ready) this.rpc.notify('workspace/didChangeConfiguration', { settings });
	}

	/** Runs a server command; false when the server does not offer it. */
	async executeCommand(command: Command): Promise<boolean> {
		if (!this.capabilities.executeCommandProvider?.commands?.includes(command.command)) return false;
		await this.rpc.request('workspace/executeCommand', { command: command.command, arguments: command.arguments });
		return true;
	}

	/** A server command's result (`workspace/executeCommand`), e.g. typescript-language-server's
	 * Go to Source Definition; rejects when the server does not know it. */
	executeCommandResult<T = unknown>(command: string, args: unknown[]): Promise<T | null> {
		return this.rpc.request<T | null>('workspace/executeCommand', { command, arguments: args });
	}

	/** Whether the server wants `workspace/willRenameFiles` (edits to make before files move). */
	get takesWillRename(): boolean {
		return !!this.capabilities.workspace?.fileOperations?.willRename;
	}
	willRenameFiles(files: { oldUri: string; newUri: string }[]): Promise<WorkspaceEdit | null> {
		return this.rpc.request<WorkspaceEdit | null>('workspace/willRenameFiles', { files });
	}
	/** Files were renamed or moved (`workspace/didRenameFiles`), when the server asks for it. */
	didRenameFiles(files: { oldUri: string; newUri: string }[]) {
		if (this.capabilities.workspace?.fileOperations?.didRename && files.length) this.rpc.notify('workspace/didRenameFiles', { files });
	}

	/** Files changed on disk behind the server's back (Search: Replace, rename into unopened files). */
	didChangeWatchedFiles(uris: string[]) {
		if (uris.length) this.rpc.notify('workspace/didChangeWatchedFiles', { changes: uris.map((uri) => ({ uri, type: 2 })) });
	}

	/** LSP version of an open document, or undefined. */
	versionOf(uri: string) {
		return this.docs.get(uri)?.version;
	}
}
