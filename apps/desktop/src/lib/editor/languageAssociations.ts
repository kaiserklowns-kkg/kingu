// Generated from each built-in extension's `contributes.languages` in microsoft/vscode
// (extensions/*/package.json), with VS Code's language ids mapped to Kingu's (Monaco's) ids:
// shellscript → shell, jsonc → json, jade → pug, coffeescript → coffee, dockercompose → yaml.
// Languages with no tokenizer in Monaco or Kingu (groovy, latex, log, …) are left out.

export type LanguageAssociation = {
	id: string;
	extensions?: string[];
	filenames?: string[];
	filenamePatterns?: string[];
	firstLine?: string;
};

export const VSCODE_ASSOCIATIONS: LanguageAssociation[] = [
	{id:"bat",extensions:[".bat",".cmd"]},
	{id:"clojure",extensions:[".clj",".cljs",".cljc",".cljx",".clojure",".edn"]},
	{id:"coffee",extensions:[".coffee",".cson",".iced"]},
	{id:"json",extensions:[".code-workspace","language-configuration.json","icon-theme.json","color-theme.json"],filenames:["settings.json","launch.json","tasks.json","mcp.json","keybindings.json","extensions.json","argv.json","profiles.json","devcontainer.json",".devcontainer.json"]},
	{id:"json",extensions:[".code-profile"]},
	{id:"ignore",filenamePatterns:[".copilotignore"]},
	{id:"markdown",extensions:[".copilotmd"]},
	{id:"c",extensions:[".c",".i"]},
	{id:"cpp",extensions:[".cpp",".cppm",".cc",".ccm",".cxx",".cxxm",".c++",".c++m",".hpp",".hh",".hxx",".h++",".h",".ii",".ino",".inl",".ipp",".ixx",".mpp",".mxx",".tpp",".txx",".hpp.in",".h.in"]},
	{id:"cpp",extensions:[".cu",".cuh"]},
	{id:"csharp",extensions:[".cs",".csx",".cake"]},
	{id:"css",extensions:[".css"]},
	{id:"dart",extensions:[".dart"]},
	{id:"diff",extensions:[".diff",".patch",".rej"]},
	{id:"dockerfile",extensions:[".dockerfile",".containerfile"],filenames:["Dockerfile","Containerfile"],filenamePatterns:["Dockerfile.*","Containerfile.*"]},
	{id:"dotenv",extensions:[".env"],filenames:[".env",".flaskenv","user-dirs.dirs"],filenamePatterns:[".env.*"]},
	{id:"ignore",filenames:[".vscodeignore"]},
	{id:"fsharp",extensions:[".fs",".fsi",".fsx",".fsscript"]},
	{id:"ignore",extensions:[".gitignore_global",".gitignore",".git-blame-ignore-revs"]},
	{id:"go",extensions:[".go"]},
	{id:"handlebars",extensions:[".handlebars",".hbs",".hjs"]},
	{id:"html",extensions:[".html",".htm",".shtml",".xhtml",".xht",".mdoc",".jsp",".asp",".aspx",".jshtm",".volt",".ejs",".rhtml"]},
	{id:"ini",extensions:[".ini"]},
	{id:"properties",extensions:[".conf",".properties",".cfg",".directory",".gitattributes",".gitconfig",".gitmodules",".editorconfig",".repo"],filenames:["gitconfig"],filenamePatterns:["**/.config/git/config","**/.git/config"]},
	{id:"java",extensions:[".java",".jav"]},
	{id:"javascriptreact",extensions:[".jsx"]},
	{id:"javascript",extensions:[".js",".es6",".mjs",".cjs",".pac"],filenames:["jakefile"],firstLine:"^#!.*\\bnode"},
	{id:"json",extensions:[".json",".bowerrc",".jscsrc",".webmanifest",".js.map",".css.map",".ts.map",".har",".jslintrc",".jsonld",".geojson",".ipynb",".vuerc"],filenames:["composer.lock",".watchmanconfig"]},
	{id:"json",extensions:[".jsonc",".eslintrc",".eslintrc.json",".jsfmtrc",".jshintrc",".swcrc",".hintrc",".babelrc",".toolset.jsonc"],filenames:["babel.config.json","bun.lock",".babelrc.json",".ember-cli","typedoc.json"],filenamePatterns:["**/.github/hooks/*.json"]},
	{id:"json",extensions:[".code-snippets"],filenamePatterns:["**/User/snippets/*.json","**/User/profiles/*/snippets/*.json","**/snippets*.json"]},
	{id:"julia",extensions:[".jl"],firstLine:"^#!\\s*/.*\\bjulia[0-9.-]*\\b"},
	{id:"less",extensions:[".less"]},
	{id:"lua",extensions:[".lua"]},
	{id:"makefile",extensions:[".mak",".mk"],filenames:["Makefile","makefile","GNUmakefile","OCamlMakefile"],firstLine:"^#!\\s*/usr/bin/make"},
	{id:"markdown",extensions:[".md",".mkd",".mkdn",".mdwn",".mdown",".markdown",".markdn",".mdtxt",".mdtext",".litcoffee",".ron",".ronn",".workbook"],filenamePatterns:["**/.cursor/**/*.mdc"]},
	{id:"ignore",extensions:[".npmignore"]},
	{id:"properties",extensions:[".npmrc"]},
	{id:"objective-c",extensions:[".m"]},
	{id:"perl",extensions:[".pl",".pm",".pod",".t",".PL",".psgi"],firstLine:"^#!.*\\bperl\\b"},
	{id:"php",extensions:[".php",".php4",".php5",".phtml",".ctp"],firstLine:"^#!\\s*/.*\\bphp\\b"},
	{id:"powershell",extensions:[".ps1",".psm1",".psd1",".pssc",".psrc"],firstLine:"^#!\\s*/.*\\bpwsh\\b"},
	{id:"pug",extensions:[".pug",".jade"]},
	{id:"python",extensions:[".py",".rpy",".pyw",".cpy",".gyp",".gypi",".pyi",".ipy",".pyt"],filenames:["SConstruct","SConscript"],firstLine:"^#!\\s*/?.*\\bpython[0-9.-]*\\b"},
	{id:"r",extensions:[".R",".Rhistory",".Rprofile",".rt"]},
	{id:"razor",extensions:[".cshtml",".razor"]},
	{id:"restructuredtext",extensions:[".rst"]},
	{id:"ruby",extensions:[".rb",".rbx",".rjs",".gemspec",".rake",".ru",".erb",".podspec",".rbi"],filenames:["rakefile","gemfile","guardfile","podfile","capfile","cheffile","hobofile","vagrantfile","appraisals","rantfile","berksfile","berksfile.lock","thorfile","puppetfile","dangerfile","brewfile","fastfile","appfile","deliverfile","matchfile","scanfile","snapfile","gymfile"],firstLine:"^#!\\s*/.*\\bruby\\b"},
	{id:"rust",extensions:[".rs"]},
	{id:"scss",extensions:[".scss"]},
	{id:"shell",extensions:[".sh",".bash",".bashrc",".bash_aliases",".bash_profile",".bash_login",".ebuild",".eclass",".profile",".bash_logout",".xprofile",".xsession",".xsessionrc",".Xsession",".zsh",".zshrc",".zprofile",".zlogin",".zlogout",".zshenv",".zsh-theme",".fish",".ksh",".csh",".cshrc",".tcshrc",".yashrc",".yash_profile"],filenames:["APKBUILD","PKGBUILD",".envrc",".hushlogin","zshrc","zshenv","zlogin","zprofile","zlogout","bashrc_Apple_Terminal","zshrc_Apple_Terminal"],firstLine:"^#!.*\\b(bash|fish|zsh|sh|ksh|dtksh|pdksh|mksh|ash|dash|yash|sh|csh|jcsh|tcsh|itcsh).*|^#\\s*-\\*-[^*]*mode:\\s*shell-script[^*]*-\\*-"},
	{id:"sql",extensions:[".sql",".dsql"]},
	{id:"swift",extensions:[".swift"]},
	{id:"typescript",extensions:[".ts",".cts",".mts"],firstLine:"^#!.*\\b(deno|bun|ts-node)\\b"},
	{id:"typescriptreact",extensions:[".tsx"]},
	{id:"json",filenames:["tsconfig.json","jsconfig.json"],filenamePatterns:["tsconfig.*.json","jsconfig.*.json","tsconfig-*.json","jsconfig-*.json"]},
	{id:"json",extensions:[".tsbuildinfo"]},
	{id:"vb",extensions:[".vb",".brs",".vbs",".bas",".vba"]},
	{id:"xml",extensions:[".xml",".xsd",".ascx",".atom",".axml",".axaml",".bpmn",".cpt",".csl",".csproj",".csproj.user",".dita",".ditamap",".dtd",".ent",".mod",".dtml",".fsproj",".fxml",".iml",".isml",".jmx",".launch",".menu",".mxml",".nuspec",".opml",".owl",".proj",".props",".pt",".publishsettings",".pubxml",".pubxml.user",".rbxlx",".rbxmx",".rdf",".rng",".rss",".shproj",".slnx",".storyboard",".svg",".targets",".tld",".tmx",".vbproj",".vbproj.user",".vcxproj",".vcxproj.filters",".wixproj",".wsdl",".wxi",".wxl",".wxs",".xaml",".xbl",".xib",".xlf",".xliff",".xpdl",".xul",".xoml"],firstLine:"(\\<\\?xml.*)|(\\<svg)|(\\<\\!doctype\\s+svg)"},
	{id:"xml",extensions:[".xsl",".xslt"]},
	{id:"yaml",filenamePatterns:["compose.yml","compose.yaml","compose.*.yml","compose.*.yaml","*docker*compose*.yml","*docker*compose*.yaml"]},
	{id:"yaml",extensions:[".yaml",".yml",".eyaml",".eyml",".cff",".yaml-tmlanguage",".yaml-tmpreferences",".yaml-tmtheme",".winget"],firstLine:"^#cloud-config"}
];
