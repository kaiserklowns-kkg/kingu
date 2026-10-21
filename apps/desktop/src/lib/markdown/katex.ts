// KaTeX for the Markdown preview's math (VS Code's markdown-math extension). Imported lazily by
// the preview, only for a document with math, so KaTeX and its fonts stay out of the first paint.
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { MathRenderer } from './previewRender.ts';

/** No `\href`, `\url` or HTML extensions (trust: false); a TeX error renders as red source text. */
export const renderMath: MathRenderer = (tex, displayMode) => katex.renderToString(tex, { displayMode, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
