// The slice of the Language Server Protocol (3.17) Kingu speaks. Hand-written rather than
// pulling in vscode-languageserver-protocol: only these shapes are used.

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type Location = { uri: string; range: Range };
export type LocationLink = { originSelectionRange?: Range; targetUri: string; targetRange: Range; targetSelectionRange: Range };

export const DiagnosticSeverity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const;
export type Diagnostic = {
	range: Range;
	severity?: number;
	code?: number | string;
	codeDescription?: { href: string };
	source?: string;
	message: string;
	tags?: number[];
};

export type MarkupContent = { kind: 'markdown' | 'plaintext'; value: string };
export type MarkedString = string | { language: string; value: string };
export type Hover = { contents: MarkupContent | MarkedString | MarkedString[]; range?: Range };

export type TextEdit = { range: Range; newText: string };
export type InsertReplaceEdit = { newText: string; insert: Range; replace: Range };
export type CompletionItem = {
	label: string;
	labelDetails?: { detail?: string; description?: string };
	kind?: number;
	tags?: number[];
	detail?: string;
	documentation?: string | MarkupContent;
	deprecated?: boolean;
	preselect?: boolean;
	sortText?: string;
	filterText?: string;
	insertText?: string;
	insertTextFormat?: number;
	textEdit?: TextEdit | InsertReplaceEdit;
	textEditText?: string;
	additionalTextEdits?: TextEdit[];
	commitCharacters?: string[];
	data?: unknown;
};
export type CompletionItemDefaults = {
	commitCharacters?: string[];
	editRange?: Range | { insert: Range; replace: Range };
	insertTextFormat?: number;
	data?: unknown;
};
export type CompletionList = { isIncomplete: boolean; itemDefaults?: CompletionItemDefaults; items: CompletionItem[] };

export type DocumentSymbol = {
	name: string;
	detail?: string;
	kind: number;
	tags?: number[];
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
};
export type SymbolInformation = { name: string; kind: number; tags?: number[]; location: Location; containerName?: string };

export type DocumentDiagnosticReport = { kind: 'full'; resultId?: string; items: Diagnostic[] } | { kind: 'unchanged'; resultId: string };

// --- Edits ---------------------------------------------------------------------------------------

export type TextDocumentEdit = { textDocument: { uri: string; version: number | null }; edits: TextEdit[] };
export type ResourceOperation = { kind: 'create' | 'rename' | 'delete'; [key: string]: unknown };
export type WorkspaceEdit = {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: (TextDocumentEdit | ResourceOperation)[];
	changeAnnotations?: Record<string, unknown>;
};
export type Command = { title: string; command: string; arguments?: unknown[] };
export type CodeAction = {
	title: string;
	kind?: string;
	diagnostics?: Diagnostic[];
	isPreferred?: boolean;
	disabled?: { reason: string };
	edit?: WorkspaceEdit;
	command?: Command;
	data?: unknown;
};
export type FormattingOptions = { tabSize: number; insertSpaces: boolean; trimTrailingWhitespace?: boolean; insertFinalNewline?: boolean };
export type PrepareRenameResult = Range | { range: Range; placeholder: string } | { defaultBehavior: boolean } | null;

// --- Signature help, highlights ----------------------------------------------------------------

export type ParameterInformation = { label: string | [number, number]; documentation?: string | MarkupContent };
export type SignatureInformation = { label: string; documentation?: string | MarkupContent; parameters?: ParameterInformation[]; activeParameter?: number };
export type SignatureHelp = { signatures: SignatureInformation[]; activeSignature?: number; activeParameter?: number };
export type SignatureHelpContext = { triggerKind: number; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: SignatureHelp };
export type DocumentHighlight = { range: Range; kind?: number };

export type ProgressValue = { kind: 'begin' | 'report' | 'end'; title?: string; message?: string; percentage?: number };

export type ServerCapabilities = {
	positionEncoding?: string;
	textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
	hoverProvider?: boolean | object;
	completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
	definitionProvider?: boolean | object;
	documentSymbolProvider?: boolean | object;
	workspaceSymbolProvider?: boolean | object;
	diagnosticProvider?: { interFileDependencies?: boolean; workspaceDiagnostics?: boolean };
	signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
	referencesProvider?: boolean | object;
	documentHighlightProvider?: boolean | object;
	documentFormattingProvider?: boolean | object;
	documentRangeFormattingProvider?: boolean | object;
	executeCommandProvider?: { commands?: string[] };
	[key: string]: unknown;
};

export const ErrorCodes = {
	RequestFailed: -32803,
	MethodNotFound: -32601,
	ServerCancelled: -32802,
	ContentModified: -32801,
	RequestCancelled: -32800
} as const;
