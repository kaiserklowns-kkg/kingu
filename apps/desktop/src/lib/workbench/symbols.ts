// Go to Symbol in Editor (VS Code's `@` quick access): the file's LSP symbols as one flat list.
// Pure, so it is unit-testable.
import type { DocumentSymbol, SymbolInformation } from '#lib/lsp/protocol.ts';

export type FlatSymbol = { name: string; kind: string; container: string; line: number; column: number };

// LSP SymbolKind (1-based) → the label VS Code shows next to a symbol.
const KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
export const symbolKind = (kind: number) => KINDS[kind - 1] ?? 'symbol';

const isDocumentSymbol = (s: DocumentSymbol | SymbolInformation): s is DocumentSymbol => 'selectionRange' in s;

/** Depth-first in file order; lines and columns 1-based for the editor. */
export function flattenSymbols(symbols: (DocumentSymbol | SymbolInformation)[]): FlatSymbol[] {
	const out: FlatSymbol[] = [];
	const walk = (list: DocumentSymbol[], container: string) => {
		for (const s of list) {
			const at = s.selectionRange.start;
			out.push({ name: s.name, kind: symbolKind(s.kind), container, line: at.line + 1, column: at.character + 1 });
			if (s.children?.length) walk(s.children, container ? `${container} › ${s.name}` : s.name);
		}
	};
	if (symbols.length && isDocumentSymbol(symbols[0])) walk(symbols as DocumentSymbol[], '');
	else
		for (const s of symbols as SymbolInformation[]) {
			const at = s.location.range.start;
			out.push({ name: s.name, kind: symbolKind(s.kind), container: s.containerName ?? '', line: at.line + 1, column: at.character + 1 });
		}
	return out.sort((a, b) => a.line - b.line || a.column - b.column);
}
