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

export type ProgressValue = { kind: 'begin' | 'report' | 'end'; title?: string; message?: string; percentage?: number };

export type ServerCapabilities = {
	positionEncoding?: string;
	textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
	hoverProvider?: boolean | object;
	completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
	definitionProvider?: boolean | object;
	documentSymbolProvider?: boolean | object;
	diagnosticProvider?: { interFileDependencies?: boolean; workspaceDiagnostics?: boolean };
	[key: string]: unknown;
};

export const ErrorCodes = {
	MethodNotFound: -32601,
	ServerCancelled: -32802,
	ContentModified: -32801,
	RequestCancelled: -32800
} as const;
