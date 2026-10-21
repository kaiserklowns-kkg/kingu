// Monaco providers for the language features beyond the basics in lsp.svelte.ts: go to
// declaration / type definition / implementation (and their peeks), inlay hints, semantic tokens
// (full, delta and range), folding ranges, code lens, linked editing, on-type formatting,
// selection ranges, document links and colors. Each one is registered only when the server
// advertises it (VS Code: vscode-languageclient's features), passes Monaco's cancellation token
// through, and drops answers that belong to an older version of the document.

import type * as Monaco from 'monaco-editor';
import type { LanguageClient, RefreshKind } from './client';
import { modelPathOf, toLspPosition, toLspRange, toMonacoRange, toMonacoTextEdits, toTargets } from './convert';
import {
	applySemanticTokensEdits,
	restyleSemanticTokens,
	toCodeLens,
	toColorInformation,
	toColorPresentations,
	toFoldingRanges,
	toInlayHint,
	toLinkedEditingRanges,
	toLinks,
	toSelectionRanges,
	type CommandMapper
} from './languageFeatures';
import type { CodeLens, Command, DocumentLink, InlayHint, Location, LocationLink, Position, SemanticTokens, SemanticTokensDelta, ServerCapabilities } from './protocol';
import { semanticStyler, type SemanticStyler } from './semanticStyle';

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

export type FeatureContext = {
	monaco: MonacoApi;
	key: string;
	/** Monaco language ids the server serves. */
	languages: string[];
	caps: ServerCapabilities;
	lookup(model: Model): { client: LanguageClient; uri: string } | null;
	/** Workspace-relative path of an LSP URI, or null outside the workspace. */
	relOf(uri: string): string | null;
	monacoUri(uri: string): Monaco.Uri;
	/** Read-only models for files a peek shows that have no tab. */
	ensurePreviews(rels: string[]): Promise<void>;
	/** The Monaco command that runs a server command (workspace/executeCommand or a client command). */
	commandId: string;
	add(d: Monaco.IDisposable): void;
	/** Fired by the server's refresh requests. */
	onRefresh(kind: RefreshKind, listener: () => void): void;
};

/** Monaco's cancellation error: semantic tokens keep their previous result when a request fails with it. */
function canceled(): Error {
	const e = new Error('Canceled');
	e.name = 'Canceled';
	return e;
}

/** Commands whose arguments are `(uri, position, locations)` and which VS Code shows as a references peek. */
const SHOW_REFERENCES = new Set(['editor.action.showReferences', 'rust-analyzer.showReferences']);

/** One synthetic legend for every semantic token provider: the style names (semanticStyle.ts). */
const LEGEND = { tokenTypes: [] as string[], tokenModifiers: [] as string[] };
const legendIndex = new Map<string, number>();
function styleIndex(name: string): number {
	let i = legendIndex.get(name);
	if (i === undefined) {
		i = LEGEND.tokenTypes.length;
		LEGEND.tokenTypes.push(name);
		legendIndex.set(name, i);
	}
	return i;
}

/** The server token (type index, modifier bits) → legend index of its resolved style, or -1. */
function styleResolver(styler: SemanticStyler | null, legend: { tokenTypes: string[]; tokenModifiers: string[] }, language: string) {
	const cache = new Map<number, number>();
	return (type: number, modifiers: number) => {
		if (!styler) return -1;
		const k = type * 0x100000000 + modifiers;
		let v = cache.get(k);
		if (v === undefined) {
			const name = legend.tokenTypes[type];
			const mods: string[] = [];
			for (let i = 0, m = modifiers; m > 0 && i < legend.tokenModifiers.length; i++, m >>>= 1) if (m & 1) mods.push(legend.tokenModifiers[i]);
			const synthetic = name === undefined ? null : styler.tokenName(styler.styleOf(name, mods, language));
			v = synthetic ? styleIndex(synthetic) : -1;
			cache.set(k, v);
		}
		return v;
	};
}

export function registerFeatureProviders(ctx: FeatureContext) {
	const { monaco, caps, add } = ctx;
	const emitters: Partial<Record<RefreshKind, Monaco.Emitter<void>>> = {};
	const emitter = (kind: RefreshKind) => {
		if (!emitters[kind]) {
			const e = new monaco.Emitter<void>();
			emitters[kind] = e;
			add(e);
			ctx.onRefresh(kind, () => e.fire());
		}
		return emitters[kind]!;
	};
	const toLocation = (l: Location): Monaco.languages.Location => ({ uri: ctx.monacoUri(l.uri), range: toMonacoRange(l.range) });

	/** References-style commands open Monaco's peek (`editor.action.showReferences`, as VS Code); the rest go to the server. */
	const mapCommand: CommandMapper = (command: Command) => {
		const [uri, position, locations] = command.arguments ?? [];
		if (SHOW_REFERENCES.has(command.command) && typeof uri === 'string' && isPosition(position) && Array.isArray(locations))
			return {
				id: 'editor.action.showReferences',
				title: command.title,
				arguments: [ctx.monacoUri(uri), { lineNumber: position.line + 1, column: position.character + 1 }, (locations as Location[]).filter((l) => ctx.relOf(l.uri) !== null).map(toLocation)]
			};
		return { id: ctx.commandId, title: command.title, arguments: [ctx.key, command] };
	};
	/** Files a references command's peek shows need models before it is clicked. */
	const previewsFor = async (command: Command | undefined) => {
		const locations = command && SHOW_REFERENCES.has(command.command) ? command.arguments?.[2] : undefined;
		if (Array.isArray(locations)) await ctx.ensurePreviews((locations as Location[]).map((l) => ctx.relOf(l.uri)).filter((r) => r !== null));
	};

	/** Go to declaration / type definition / implementation: like definitions, with peek models. */
	const locationProvider = (request: (client: LanguageClient, uri: string, at: Position, token: Monaco.CancellationToken) => Promise<Location | Location[] | LocationLink[] | null>) => ({
		async provide(model: Model, position: Monaco.Position, token: Monaco.CancellationToken) {
			const d = ctx.lookup(model);
			const result = d && (await request(d.client, d.uri, toLspPosition(position), token).catch(() => null));
			const targets = toTargets(result);
			await ctx.ensurePreviews(targets.map((t) => ctx.relOf(t.uri)).filter((r) => r !== null));
			return targets.map((t) => ({ uri: ctx.monacoUri(t.uri), range: toMonacoRange(t.range) }));
		}
	});

	for (const language of ctx.languages) {
		if (caps.declarationProvider) {
			const p = locationProvider((c, u, at, tk) => c.declaration(u, at, tk));
			add(monaco.languages.registerDeclarationProvider(language, { provideDeclaration: p.provide }));
		}
		if (caps.typeDefinitionProvider) {
			const p = locationProvider((c, u, at, tk) => c.typeDefinition(u, at, tk));
			add(monaco.languages.registerTypeDefinitionProvider(language, { provideTypeDefinition: p.provide }));
		}
		if (caps.implementationProvider) {
			const p = locationProvider((c, u, at, tk) => c.implementation(u, at, tk));
			add(monaco.languages.registerImplementationProvider(language, { provideImplementation: p.provide }));
		}

		if (caps.inlayHintProvider) {
			const origin = new WeakMap<Monaco.languages.InlayHint, { client: LanguageClient; hint: InlayHint }>();
			add(
				monaco.languages.registerInlayHintsProvider(language, {
					displayName: ctx.key,
					onDidChangeInlayHints: emitter('inlayHint').event,
					provideInlayHints: async (model, range, token) => {
						const d = ctx.lookup(model);
						const version = model.getVersionId();
						const hints = d && (await d.client.inlayHints(d.uri, toLspRange(range), token).catch(() => null));
						if (!d || !hints || model.isDisposed() || model.getVersionId() !== version) return { hints: [], dispose() {} };
						return {
							hints: hints.map((h) => {
								const m = toInlayHint(h, mapCommand, toLocation);
								origin.set(m, { client: d.client, hint: h });
								return m;
							}),
							dispose() {}
						};
					},
					resolveInlayHint: async (hint, token) => {
						const o = origin.get(hint);
						if (!o?.client.canResolveInlayHint) return hint;
						const r = await o.client.resolveInlayHint(o.hint, token).catch(() => null);
						return r ? { ...hint, ...toInlayHint(r, mapCommand, toLocation), position: hint.position } : hint;
					}
				})
			);
		}

		const legend = caps.semanticTokensProvider?.legend;
		if (legend && (caps.semanticTokensProvider?.full || caps.semanticTokensProvider?.range)) {
			// The server's raw data per model, for applying deltas to.
			const previous = new WeakMap<Model, { resultId: string; data: number[] }>();
			const restyle = (model: Model, data: readonly number[]) => restyleSemanticTokens(data, styleResolver(semanticStyler(), legend, model.getLanguageId()));
			if (caps.semanticTokensProvider?.full)
				add(
					monaco.languages.registerDocumentSemanticTokensProvider(language, {
						onDidChange: emitter('semanticTokens').event,
						getLegend: () => LEGEND,
						provideDocumentSemanticTokens: async (model, lastResultId, token) => {
							const d = ctx.lookup(model);
							if (!d) throw canceled();
							const prev = previous.get(model);
							let result: SemanticTokens | SemanticTokensDelta | null;
							try {
								result =
									lastResultId && prev && prev.resultId === lastResultId && d.client.semanticTokensDelta
										? await d.client.semanticTokensEdits(d.uri, prev.resultId, token)
										: await d.client.semanticTokens(d.uri, token);
							} catch {
								previous.delete(model);
								throw canceled(); // busy or content modified: keep what is shown, ask again later
							}
							if (!result || model.isDisposed()) throw canceled();
							let data: number[];
							if ('edits' in result) {
								try {
									data = applySemanticTokensEdits(prev!.data, result.edits);
								} catch {
									previous.delete(model);
									throw canceled();
								}
							} else data = result.data;
							if (result.resultId) previous.set(model, { resultId: result.resultId, data });
							else previous.delete(model);
							return { resultId: result.resultId, data: restyle(model, data) };
						},
						releaseDocumentSemanticTokens: () => {}
					})
				);
			if (caps.semanticTokensProvider?.range)
				add(
					monaco.languages.registerDocumentRangeSemanticTokensProvider(language, {
						onDidChange: emitter('semanticTokens').event,
						getLegend: () => LEGEND,
						provideDocumentRangeSemanticTokens: async (model, range, token) => {
							const d = ctx.lookup(model);
							const result = d && (await d.client.semanticTokensInRange(d.uri, toLspRange(range), token).catch(() => null));
							if (!result || model.isDisposed()) throw canceled();
							return { resultId: result.resultId, data: restyle(model, result.data) };
						}
					})
				);
		}

		if (caps.foldingRangeProvider) {
			const kinds: Record<string, Monaco.languages.FoldingRangeKind> = {
				comment: monaco.languages.FoldingRangeKind.Comment,
				imports: monaco.languages.FoldingRangeKind.Imports,
				region: monaco.languages.FoldingRangeKind.Region
			};
			add(
				monaco.languages.registerFoldingRangeProvider(language, {
					provideFoldingRanges: async (model, _context, token) => {
						const d = ctx.lookup(model);
						const ranges = d && (await d.client.foldingRanges(d.uri, token).catch(() => null));
						return toFoldingRanges(ranges, (k) => kinds[k] ?? new monaco.languages.FoldingRangeKind(k));
					}
				})
			);
		}

		if (caps.codeLensProvider) {
			const origin = new WeakMap<Monaco.languages.CodeLens, { client: LanguageClient; lens: CodeLens }>();
			const codeLensChanged = emitter('codeLens');
			add(
				monaco.languages.registerCodeLensProvider(language, {
					onDidChange: codeLensChanged.event as unknown as Monaco.IEvent<Monaco.languages.CodeLensProvider>,
					provideCodeLenses: async (model, token) => {
						const d = ctx.lookup(model);
						const lenses = d && (await d.client.codeLenses(d.uri, token).catch(() => null));
						if (!d || !lenses) return { lenses: [], dispose() {} };
						await Promise.all(lenses.map((l) => previewsFor(l.command)));
						return {
							lenses: lenses.map((l) => {
								const m = toCodeLens(l, mapCommand);
								origin.set(m, { client: d.client, lens: l });
								return m;
							}),
							dispose() {}
						};
					},
					resolveCodeLens: async (_model, lens, token) => {
						const o = origin.get(lens);
						if (!o || lens.command || !o.client.canResolveCodeLens) return lens;
						const r = await o.client.resolveCodeLens(o.lens, token).catch(() => null);
						if (!r) return lens;
						await previewsFor(r.command);
						return toCodeLens(r, mapCommand);
					}
				})
			);
		}

		if (caps.linkedEditingRangeProvider)
			add(
				monaco.languages.registerLinkedEditingRangeProvider(language, {
					provideLinkedEditingRanges: async (model, position, token) => {
						const d = ctx.lookup(model);
						return toLinkedEditingRanges(d && (await d.client.linkedEditingRange(d.uri, toLspPosition(position), token).catch(() => null)));
					}
				})
			);

		const onType = caps.documentOnTypeFormattingProvider;
		if (onType?.firstTriggerCharacter)
			add(
				monaco.languages.registerOnTypeFormattingEditProvider(language, {
					autoFormatTriggerCharacters: [onType.firstTriggerCharacter, ...(onType.moreTriggerCharacter ?? [])],
					provideOnTypeFormattingEdits: async (model, position, ch, options, token) => {
						const d = ctx.lookup(model);
						const version = model.getVersionId();
						const fmt = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
						const edits = d && (await d.client.onTypeFormatting(d.uri, toLspPosition(position), ch, fmt, token).catch(() => null));
						return model.getVersionId() === version ? toMonacoTextEdits(edits) : [];
					}
				})
			);

		if (caps.selectionRangeProvider)
			add(
				monaco.languages.registerSelectionRangeProvider(language, {
					provideSelectionRanges: async (model, positions, token) => {
						const d = ctx.lookup(model);
						return toSelectionRanges(d && (await d.client.selectionRanges(d.uri, positions.map(toLspPosition), token).catch(() => null)));
					}
				})
			);

		if (caps.documentLinkProvider) {
			const origin = new WeakMap<Monaco.languages.ILink, { client: LanguageClient; link: DocumentLink }>();
			// Workspace files open as tabs (the editor opener takes model paths: `/rel`, or absolute in another root folder); other targets stay URLs.
			const target = (url: string | undefined) => {
				if (!url) return undefined;
				const rel = url.startsWith('file:') ? ctx.relOf(url.replace(/#.*$/, '')) : null;
				return rel !== null ? monaco.Uri.file(modelPathOf(rel)).with({ fragment: /#(.*)$/.exec(url)?.[1] ?? '' }) : url;
			};
			add(
				monaco.languages.registerLinkProvider(language, {
					provideLinks: async (model, token) => {
						const d = ctx.lookup(model);
						const links = d && (await d.client.documentLinks(d.uri, token).catch(() => null));
						if (!d || !links) return { links: [] };
						return {
							links: toLinks(links).map((m, i) => {
								const out = { ...m, url: target(m.url as string | undefined) };
								origin.set(out, { client: d.client, link: links[i] });
								return out;
							})
						};
					},
					resolveLink: async (link, token) => {
						const o = origin.get(link);
						if (!o || link.url || !o.client.canResolveDocumentLink) return link;
						const r = await o.client.resolveDocumentLink(o.link, token).catch(() => null);
						return r ? { ...link, url: target(r.target), tooltip: r.tooltip ?? link.tooltip } : link;
					}
				})
			);
		}

		if (caps.colorProvider)
			add(
				monaco.languages.registerColorProvider(language, {
					provideDocumentColors: async (model, token) => {
						const d = ctx.lookup(model);
						return toColorInformation(d && (await d.client.documentColors(d.uri, token).catch(() => null)));
					},
					provideColorPresentations: async (model, info, token) => {
						const d = ctx.lookup(model);
						return toColorPresentations(d && (await d.client.colorPresentations(d.uri, { ...info.color }, toLspRange(info.range), token).catch(() => null)));
					}
				})
			);
	}
}

function isPosition(p: unknown): p is Position {
	return typeof p === 'object' && p !== null && typeof (p as Position).line === 'number' && typeof (p as Position).character === 'number';
}

