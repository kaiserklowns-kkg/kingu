// The part of the `emmet` package (2.4.11) Kingu uses. Its package.json `exports` has no `types`
// condition, so TypeScript does not find dist/index.d.ts on its own; these mirror it.
declare module 'emmet' {
	export type SyntaxType = 'markup' | 'stylesheet';
	export interface UserConfig {
		type?: SyntaxType;
		syntax?: string;
		options?: Record<string, unknown>;
		variables?: Record<string, string>;
		snippets?: Record<string, string>;
		text?: string | string[];
		maxRepeat?: number;
	}
	export interface ExtractedAbbreviation {
		abbreviation: string;
		location: number;
		start: number;
		end: number;
	}
	export default function expandAbbreviation(abbr: string, config?: UserConfig): string;
	export function extract(line: string, pos?: number, options?: { lookAhead?: boolean; type?: SyntaxType; prefix?: string }): ExtractedAbbreviation | undefined;
	export function resolveConfig(config?: UserConfig): { snippets: Record<string, string>; options: Record<string, unknown> };
}
