# Third-party notice: TextMate grammars and VS Code themes

The files in `grammars/` and `themes/` are copied unmodified from the
[microsoft/vscode](https://github.com/microsoft/vscode) repository (taken from a
local fork at VS Code 1.143.0). Only one file was renamed:
`Regular Expressions (JavaScript).tmLanguage` → `RegularExpressionsJavaScript.tmLanguage`.

| File | Source path in microsoft/vscode | Upstream (see the file's `version` field / the extension's `cgmanifest.json`) | Upstream license |
| --- | --- | --- | --- |
| grammars/TypeScript.tmLanguage.json | extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json | microsoft/TypeScript-TmLanguage | MIT |
| grammars/jsdoc.ts.injection.tmLanguage.json | extensions/typescript-basics/syntaxes/jsdoc.ts.injection.tmLanguage.json | microsoft/vscode | MIT |
| grammars/jsdoc.js.injection.tmLanguage.json | extensions/typescript-basics/syntaxes/jsdoc.js.injection.tmLanguage.json | microsoft/vscode | MIT |
| grammars/JavaScript.tmLanguage.json | extensions/javascript/syntaxes/JavaScript.tmLanguage.json | microsoft/TypeScript-TmLanguage | MIT |
| grammars/RegularExpressionsJavaScript.tmLanguage | extensions/javascript/syntaxes/Regular Expressions (JavaScript).tmLanguage | textmate/javascript.tmbundle | TextMate Bundle License |
| grammars/rust.tmLanguage.json | extensions/rust/syntaxes/rust.tmLanguage.json | dustypomerleau/rust-syntax | MIT |
| grammars/go.tmLanguage.json | extensions/go/syntaxes/go.tmLanguage.json | worlpaker/go-syntax | MIT |
| grammars/JSON.tmLanguage.json | extensions/json/syntaxes/JSON.tmLanguage.json | microsoft/vscode-JSON.tmLanguage | MIT |
| grammars/markdown.tmLanguage.json | extensions/markdown-basics/syntaxes/markdown.tmLanguage.json | microsoft/vscode-markdown-tm-grammar (derived from textmate/markdown.tmbundle) | MIT / TextMate Bundle License |
| grammars/css.tmLanguage.json | extensions/css/syntaxes/css.tmLanguage.json | microsoft/vscode-css | MIT |
| grammars/html.tmLanguage.json | extensions/html/syntaxes/html.tmLanguage.json | textmate/html.tmbundle | TextMate Bundle License |
| grammars/html-derivative.tmLanguage.json | extensions/html/syntaxes/html-derivative.tmLanguage.json | textmate/html.tmbundle | TextMate Bundle License |
| themes/dark_modern.json | extensions/theme-defaults/themes/dark_modern.json | microsoft/vscode | MIT |
| themes/dark_plus.json | extensions/theme-defaults/themes/dark_plus.json | microsoft/vscode | MIT |
| themes/dark_vs.json | extensions/theme-defaults/themes/dark_vs.json | microsoft/vscode | MIT |

There is no Svelte grammar here: VS Code does not ship one, so `.svelte` files
use the HTML grammar for now.

## microsoft/vscode — MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## TextMate Bundle License (textmate/html.tmbundle, javascript.tmbundle, markdown.tmbundle)

Copyright (c) textmate-*.tmbundle project authors

Permission to copy, use, modify, sell and distribute this
software is granted. This software is provided "as is" without
express or implied warranty, and with no claim as to its
suitability for any purpose.

The upstream MIT notices of the third-party grammar projects listed above are
reproduced in microsoft/vscode's `ThirdPartyNotices.txt`.
