# IDE parity with VS Code (P0 areas)

- **Date:** 2026-11-13
- **References:** VS Code source `src/vs/**` (shallow clone of microsoft/vscode) and the user docs in microsoft/vscode-docs (`docs/reference/default-keybindings.md`, `docs/editing/`, `docs/getstarted/userinterface.md`, `docs/sourcecontrol/`, `docs/terminal/`).
- **Scope:** the P0 areas in `docs/PLAN.md` §00.2: open folder, explorer, editor tabs and groups, search, Source Control, terminal, command palette and quick open, and basic LSP. Debugger and the other P1 areas are only listed where they share keys with a P0 area.
- **Method:**
  1. Every command id in `default-keybindings.md` was checked against the ids Kingu registers (`commands.register` across `apps/desktop/src/lib`).
  2. Keys and `when` clauses were read from the VS Code contribution named in each row.
  3. `keymapAudit.test.ts` checks that no key runs two commands in one layout.
- **Status:** ✅ present · ◐ partial · ✗ missing · 🆕 added in the first parity round · 🆕² added in the second (P0 gaps of §9) · 🆕³ added in the third (§9 leftovers and §8.1–8.6) · 🆕⁴ added in the fourth (the last §9 and §15 gaps).
- **Priority:** P0-a = daily use, do next. P0-b = used often, do soon. P0-c = rare.

## 1. Open folder and workspace

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Open Folder (⌘O on macOS: `workbench.action.files.openFileFolder`), Open Recent (⌃R) | `workbench/browser/actions/workspaceActions.ts`, `windowActions.ts` | ✅ `workspace.svelte.ts`, `recentFiles.svelte.ts` | – |
| Multi-root (Add / Remove Folder), `.code-workspace` | `docs/editing/workspaces/multi-root-workspaces.md` | ✅ `workspaceFolders.ts`, `workspaceFile.ts` | – |
| Workspace Trust | `contrib/workspace/browser/workspace.contribution.ts` | ✅ `workspaceTrust.svelte.ts` | – |
| Hot exit / restore of untitled and dirty editors | `files.hotExit` | ✅ `editorRestore.svelte.ts`, `editorLayout.ts` | – |

## 2. Explorer

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| New File / Folder, rename (↩ on macOS, F2), delete to trash (⌘⌫) with `explorer.confirmDelete` | `contrib/files/browser/fileActions.contribution.ts`, `fileActions.ts` | ✅ `ExplorerView.svelte` `onTreeKey`, `explorer.svelte.ts` | – |
| Copy / cut / paste (⌘C/⌘X/⌘V), multi-select, drag and drop | `fileActions.ts`, `views/explorerViewer.ts` | ✅ `explorer.svelte.ts`, `fileMoves.ts` | – |
| Copy Path ⌥⌘C, Copy Relative Path ⌥⇧⌘C, Reveal in Finder ⌥⌘R | `fileCommands.ts:255-300`, `electron-browser/fileActions.contribution.ts:31` | ✅ `ExplorerView.svelte`, `editorCommands.svelte.ts` | – |
| `explorer.openAndPassFocus`: ⌘↓ on macOS, Enter elsewhere (pinned, focus in the editor) | `fileCommands.ts:122` | 🆕 `ExplorerView.svelte` | P0-a |
| `explorer.openToSide`: ⌃↩ on macOS, Ctrl+Enter elsewhere | `fileCommands.ts:84` | 🆕 `ExplorerView.svelte` | P0-b |
| Home / End / PageUp / PageDown in the tree (⇧ extends the selection) | `base/browser/ui/list/listWidget.ts` | 🆕 `ExplorerView.svelte` | P0-b |
| File nesting, compact folders, `files.exclude` | `explorer.fileNesting.*`, `explorer.compactFolders` | ✅ `fileNesting.ts`, `explorerModel.ts` | – |
| Undo / redo of file operations (⌘Z / ⇧⌘Z, Ctrl+Y off macOS, with focus in the Explorer): New File / Folder, rename, move (paste after cut, drag), copy (paste, ⌥-drag, drop from Finder), delete (to the Trash or, with `files.enableTrash` off, for good); `explorer.enableUndo`, `explorer.confirmUndo` ("Would you like to undo '…'?": always for New, for copies unless `light`, the rest only `verbose`) | `files.contribution.ts:681` (`UndoCommand` for the explorer), `fileActions.ts` `applyBulkEdit` undo labels, `bulkFileEdits.ts` | 🆕² `explorer.svelte.ts` `undoRedo` on `ade/fileUndo.ts`; a delete is undone from the copy Rust keeps (`fs_delete` token, `fs_restore`), a permanent delete too (🆕⁴ `fileops::delete_for_good_with_undo`; VS Code's `DeleteOperation` keeps a deleted file's contents for undo either way). Not undoable, as in VS Code: an entry too large to copy, and the old file a move replaced (`RenameOperation` only moves back) | P0-b |
| Type to navigate (letters within 800 ms jump to the next row starting with them) / Find in the tree (⌥⌘F or F3: Filter and Fuzzy Match toggles, `workbench.list.defaultFindMode`, `workbench.list.defaultFindMatchType`, ↑↓ through highlighted rows only, Esc closes) | `listWidget.ts` TypeNavigationController, `abstractTree.ts` FindController, `listCommands.ts:861` `list.find` | 🆕² `ExplorerView.svelte`, `explorerModel.ts` `typeNavigate`. 🆕³ Find also searches collapsed folders (VS Code's ExplorerFindProvider: every workspace file from `fs_list_files`; the folders on the way to the first 100 matches open, and close again with the find); `workbench.list.typeNavigationMode: trigger` with `list.triggerTypeNavigation` | P0-b |
| Open Editors view | `contrib/files/browser/views/openEditorsView.ts` | ✅ `openEditors.ts` | – |

## 3. Editor tabs and groups

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Preview tabs (italic, replaced by the next preview; double-click or edit pins), `workbench.editor.enablePreview` | `common/editor/editorGroupModel.ts` | ✅ `editorGroups.ts` | – |
| Pinned (sticky) tabs ⌘K ⇧↩, Keep Editor ⌘K ↩ | `editorCommands.ts` | ✅ `editorCommands.svelte.ts`, `Workbench.svelte` | – |
| Close ⌘W, Close All ⌘K ⌘W, Close Saved ⌘K U, Close Others ⌥⌘T, Reopen Closed ⇧⌘T, dirty prompts | `editorActions.ts` | ✅ `editorCommands.svelte.ts`, `textFileService.svelte.ts` | – |
| Next / Previous Editor ⌥⌘→ / ⌥⌘←, ⌃Tab MRU picker | `editorActions.ts` | ✅ | – |
| Open Editor at Index ⌃1…⌃9 (⌥1…⌥9 off macOS), Last Editor in Group ⌃0 | `editorCommands.ts:651` `openEditorAtIndex`, `editorActions.ts:1441` | 🆕 `editorNavCommands.svelte.ts` | P0-a |
| Split ⌘\, Focus Group ⌘1 / ⌘2 / ⌘3 | `editorActions.ts` | ✅ `Workbench.svelte` | – |
| Focus Group ⌘4…⌘8 (one past the last creates it) | `editorCommands.ts:715` | 🆕 `editorNavCommands.svelte.ts` | P0-b |
| Focus Left / Right / Above / Below Group ⌘K ⌘← → ↑ ↓ (wraps); Focus Next / Previous / Last Group | `editorActions.ts:315-404` | 🆕 `editorNavCommands.svelte.ts`, `editorGroups.ts` `groupInDirection` | P0-a |
| Move Editor Left / Right in Group ⌘K ⇧⌘← / → (⌃⇧PgUp / PgDn off macOS), Move to Start / End | `editorActions.ts:2062` | 🆕 `editorGroups.ts` `moveEditorInGroup` | P0-b |
| Move Editor into Previous / Next Group ⌃⌘← / ⌃⌘→, First / Last Group ⌃⌘1 / ⌃⌘9 | `editorActions.ts:2128-2244`, `editorCommands.ts:300` | 🆕 Previous / First / Last; Next already existed, its keys are 🆕 | P0-a |
| Copy Path of Active File ⌘K P, Reveal Active File in Finder ⌘K R | `fileCommands.ts:306`, `electron-browser/fileActions.contribution.ts:47` | 🆕 `editorNavCommands.svelte.ts` | P0-c |
| Move Editor Group ⌘K ← → ↑ ↓ (`moveActiveEditorGroupLeft` …): past its neighbour, else beside a neighbour across, no wrap | `editorActions.ts:900-1040` `MoveGroupAction`, `editorPart.ts` `moveGroup` | 🆕² `editorGroups.ts` `moveGroup`, `editorNavCommands.svelte.ts` | P0-c |
| Lock group, maximize ⌘K ⌘M, split in group ⌘K ⇧⌘\, layouts | `editorActions.ts` | ✅ | – |
| Auto save (`files.autoSave`), Save All ⌥⌘S | `textfiles` | ✅ `editorModels.ts`, `textFiles.ts` | – |

## 4. Search (Find in Files)

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| ⇧⌘F with selection seed, ripgrep streaming, include / exclude globs, `.gitignore` toggle, history ↑/↓ | `contrib/search/browser/searchView.ts`, `searchWidget.ts` | ✅ `search.svelte.ts`, `SearchView.svelte`, Rust `search_text` | – |
| Replace with preview, Replace All with confirmation, Preserve Case | `replaceService.ts` | ✅ | – |
| Replace in Files ⇧⌘H (opens the view with Replace shown) | `searchActionsNav.ts:399` | 🆕 `searchViewCommands.svelte.ts` | P0-a |
| Toggle Match Case / Whole Word / Regex / Preserve Case ⌥⌘C / ⌥⌘W / ⌥⌘R / ⌥⌘P with focus in the view (⌥C … off macOS) | `searchActionsNav.ts:84-160`, `editor/contrib/find/browser/findModel.ts:39` | 🆕 (the view's tooltips advertised these keys but nothing was bound) | P0-a |
| Toggle Search Details ⇧⌘J | `searchActionsNav.ts:34` | 🆕 (over Worktree Jump while the view has focus) | P0-b |
| Focus Next / Previous Search Result F4 / ⇧F4 (from anywhere, wraps, opens a preview) | `searchActionsNav.ts:359`, `searchView.ts` `selectNextMatch` | 🆕 `search.svelte.ts` `stepMatch`, `searchResults.ts` | P0-a |
| Refresh, Clear, Collapse / Expand All, View as List / Tree in the palette | `searchActionsTopBar.ts` | 🆕 (before only as buttons) | P0-c |
| Dismiss (`search.action.remove`: ⌘⌫, Delete off macOS) and Replace / Replace All in File / Replace All in Folder (`search.action.replace` / `replaceAllInFile` / `replaceAllInFolder`: ⇧⌘1) on the focused result, plus hover buttons (× on every row, Replace All on folders) | `searchActionsRemoveReplace.ts:59-260` | 🆕² `searchViewCommands.svelte.ts`, `search.svelte.ts` `dismiss` / `replaceRow`. 🆕³ the secondary ⇧⌘↩ for Replace All in File / Folder (in the results tree) | P0-b |
| Search Editor | `contrib/searchEditor` | ✅ `searchEditor*.ts` | – |
| Quick Search `%` in quick open (`workbench.action.quickTextSearch`) | `quickTextSearch/textSearchQuickAccess.ts` | 🆕² see §7 | P0-c |

## 5. Source Control (Git)

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Changes / Staged / Untracked groups, stage / unstage / discard inline, diff on click | `extensions/git/src/commands.ts`, `docs/sourcecontrol/overview.md` | ✅ `ScmView.svelte`, `scm.svelte.ts` | – |
| Commit ⌘↩ from the input, smart commit, amend, no-verify, input validation | `git.commit*` | ✅ | – |
| Pull / push / sync / fetch / branches / stash / tags / worktrees, graph, blame, timeline | `git.*` | ✅ `scm.svelte.ts`, `lib/scm/*` | – |
| Stage / unstage selected ranges, quick diff gutter, next / previous change | `git.stageSelectedRanges`, `quickDiff` | ✅ `lib/scm/quickDiff.svelte.ts` | – |
| Stage / Unstage / Discard Changes of the active file (`git.stage`, `git.unstage`, `git.clean`), Discard All Changes (`git.cleanAll`), Open File from a diff (`git.openFile`) in the palette | `extensions/git/package.json` commands | 🆕 `lib/scm/gitCommands.svelte.ts` | P0-a |
| Merge editor, conflict actions | `mergeEditor` | ✅ | – |

## 6. Terminal

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Toggle ⌃\`, New ⌃⇧\`, split, kill, rename, find ⌘F, clear ⌘K | `contrib/terminal/browser/terminalActions.ts` | ✅ `lib/terminal/*` | – |
| Shell integration: scroll / select to command ⌘↑ / ⌘↓, run recent ⌃R, go to recent directory | `terminalContrib/*` | ✅ | – |
| Focus Next / Previous Terminal (group) ⇧⌘] / ⇧⌘[ (Ctrl+PageDown / PageUp off macOS), Resize Pane ⌃⌘← → ↑ ↓ (four cells; with no split on that axis the panel resizes, as VS Code), Focus Terminal, Switch Active Terminal (`workbench.action.quickOpenTerm`) | `terminalActions.ts:448-560`, `terminalGroup.ts:585` `resizePane` | 🆕² `terminalCommands.svelte.ts`, `terminals.svelte.ts` `focusGroup` / `resizePane`, `paneLayout.ts` `resizePaneBy`. ⌃⌘← / → in a focused terminal no longer move the editor. 🆕³ Resize Left / Right also on Linux (Ctrl+Shift+← / →; Windows has no key, as VS Code); the next group's last focused terminal gets focus | P0-b |
| `sendKeybindingsToShell`, `commandsToSkipShell`, `allowChords` | `terminal.integrated.*` | ✅ `lib/terminal/behaviour.ts` | – |

## 7. Command palette and quick open

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| ⇧⌘P `>`, ⌘P files with recent files first, `:` line (and `file:42:5`), `@` / `@:` symbols, `#` workspace symbols, `edt` / `edt mru`, `view`, `?` | `contrib/quickaccess`, `anythingQuickAccess.ts`, `gotoLineQuickAccess.ts` | ✅ `quickAccess.ts`, `QuickInput.svelte` | – |
| `task ` (recent, configured, then detected tasks; runs it), `debug ` (launch configurations and compounds, then Add Configuration...), `term ` (`1`, `1.2` in a split, editor terminals, then Create New Terminal / With Profile...), listed in `?` | `tasksQuickAccess.ts`, `debugQuickAccess.ts`, `terminalQuickAccess.ts` | 🆕² `quickAccess.ts`, `QuickInput.svelte`, `debug.svelte.ts` `launchItems` / `start({ name })` | P0-b |
| `%` quick text search: as you type, 30 files × 10 matches, ⌘↩ to the side, Open in Search View | `textSearchQuickAccess.ts` | 🆕² `QuickInput.svelte`, Rust `search_quick_text` (its own ripgrep slot, so it never cancels Find in Files) | P0-c |
| Back (`workbench.action.quickInputBack`: ⌃- on macOS, Alt+← elsewhere, over Go Back while the quick input is open): to the text before a `?` row filled in a prefix, or a multi-step picker's `onBack` | `quickInputActions.ts` | 🆕³ `quick.svelte.ts` `back`, `QuickInput.svelte` | P0-c |

## 8. Basic LSP

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Completion, hover, signature help, go to definition F12, references ⇧F12, rename F2, quick fix ⌘., format ⇧⌥F, outline, breadcrumbs | Monaco built-ins + `languageFeatures` | ✅ through Monaco with `lib/lsp/languageFeatures.ts` providers | – |
| Problems ⇧⌘M, next / previous problem F8 / ⇧F8 | `contrib/markers` | ✅ `lib/lsp/ProblemsView.svelte` | – |
| Call / type hierarchy, refactor preview | `contrib/callHierarchy`, `bulkEdit` | ✅ `hierarchy.svelte.ts`, `refactorPreview.svelte.ts` | – |

## 8.1 Editor (Monaco)

Monaco's own actions keep VS Code's ids and default keys and are listed in the palette, rebindable in keybindings.json (`editorActions.svelte.ts`); the editor settings are passed through (`settings/editorOptionMap.ts`).

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Multi-cursor: ⌥-click, ⌥⌘↑ / ⌥⌘↓ add cursor, ⌘D next match, ⌘K ⌘D skip, ⇧⌘L all matches, ⇧⌥I cursors at line ends, ⌘U undo cursor; `editor.multiCursorModifier`, `editor.multiCursorPaste` | `editor/contrib/multicursor` | ✅ Monaco | – |
| Column (box) selection: ⇧⌥-drag, ⇧⌥⌘ arrows, Toggle Column Selection Mode with its status bar item | `editor.columnSelection` | ✅ Monaco + `StatusBar.svelte` | – |
| Folding: ⌥⌘[ / ⌥⌘], ⌘K ⌘0 / ⌘K ⌘J, ⌘K ⌘[ / ⌘K ⌘], fold levels; `editor.folding`, `editor.foldingStrategy`, `editor.showFoldingControls` | `editor/contrib/folding` | ✅ Monaco | – |
| Go to Symbol in Editor ⇧⌘O / in Workspace ⌘T, Definition F12, Peek ⌥F12, References ⇧F12, Implementation ⌘F12, Call Hierarchy ⌥⇧H | `editor/contrib/gotoSymbol`, quick access `@` / `#` | ✅ Monaco + LSP providers, `QuickInput.svelte` | – |
| Rename F2 (`editor.rename.enablePreview`), Quick Fix ⌘., Refactor ⌃⇧R, Source Action, Organize Imports ⇧⌥O, Format Document ⇧⌥F / Selection ⌘K ⌘F | `editor/contrib/rename`, `codeAction`, `format` | ✅ Monaco + `lib/lsp/languageFeatures.ts`, `refactorPreview.svelte.ts` | – |
| Format on save / paste / type, `editor.codeActionsOnSave`, trim trailing whitespace, final newline | `workbench/contrib/codeEditor/browser/saveParticipants.ts` | ✅ `textFileSave.ts` | – |
| Save without Formatting ⌘K S (`workbench.action.files.saveWithoutFormatting`; Ctrl+K S on Linux, Ctrl+K Ctrl+Shift+S on Windows) | `fileCommands.ts:510` | 🆕³ `editorNavCommands.svelte.ts`, `editorModels.ts` `skipSaveParticipants`; 🆕⁴ the Windows key through a command's `win` key (VS Code's `win:`, `keys.ts` `keyOf`) | P1-b |
| Go to Last Edit Location ⌘K ⌘Q | `editorActions.ts:1605` | 🆕³ `navigation.svelte.ts` `recordEdit` / `toLastEdit`, `EditorHost.svelte` | P1-b |
| `editor.formatOnSaveMode`: `file`, `modifications` (only the lines changed against git's index version, with the range formatter), `modificationsIfAvailable` (the whole file without source control) | `saveParticipants.ts` | 🆕³ `textFileSave.ts` `changedLineRanges` / `formatRanges` | P1-c |
| Sticky scroll (`editor.stickyScroll.*`, Toggle Sticky Scroll), minimap (`editor.minimap.*`, Toggle Minimap), word wrap ⌥Z, render whitespace | `editor/contrib/stickyScroll`, `minimap` | ✅ | – |
| Breadcrumbs (⇧⌘. focus and select, ⇧⌘; focus, `breadcrumbs.*`) | `browser/parts/editor/breadcrumbs*.ts` | ✅ `breadcrumbs.ts`, `breadcrumbsCommands.svelte.ts` | – |

## 8.2 Outline and Timeline views

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Outline: follow cursor, filter on type, sort by position / name / kind, `outline.show*`, problems | `contrib/outline` | ✅ `OutlineView.svelte`, `outline.svelte.ts` | – |
| Timeline: Git history and Local History merged, source filter (`timeline.excludeSources`), paging, refresh | `contrib/timeline` | ✅ `scm/timeline.svelte.ts`, `scm/TimelineView.svelte` | – |

## 8.3 Layout: Zen, centered, parts and their positions

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Zen Mode ⌘K Z (Esc Esc), `zenMode.*`; Centered Layout; Maximize Panel; editor layouts; Customize Layout | `browser/actions/layoutActions.ts` | ✅ `layoutControls.svelte.ts`, `zenMode.ts` | – |
| Side bar left / right (`workbench.sideBar.location`, Toggle Position, Move Primary Side Bar Left / Right), panel bottom / top / left / right (Move Panel …), activity bar position, secondary side bar | `layoutActions.ts` | ✅ (🆕³ Move Primary Side Bar Left / Right, Toggle Activity Bar Visibility) | – |
| Close Primary Side Bar / Hide Panel / Hide Secondary Side Bar, Focus into Primary Side Bar / Panel / Secondary Side Bar, Focus on Files Explorer | `sidebarActions.ts`, `panelActions.ts`, `fileActions.contribution.ts` | 🆕³ `layoutControls.svelte.ts` `focusPart`. ⌘0 Focus into Primary Side Bar and ⌘Numpad0 Reset Zoom as in VS Code (Reset Zoom was ⌘0 before) | P1-b |
| Focus Next / Previous Part F6 / ⇧F6 (editor → panel → secondary side bar → status bar → activity bar → side bar; F6 pauses a running debug session first) | `navigationActions.ts:293` | 🆕³ `layoutControls.svelte.ts` `focusNeighbourPart`, `data-part` on the parts | P1-b |
| Toggle Editor Area Visibility (`workbench.action.toggleEditorVisibility`: VS Code runs Toggle Maximized Panel for it) | `layoutActions.ts:260` | 🆕³ `layoutControls.svelte.ts` | P1-c |

## 8.4 Multi-root workspaces

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Add / Remove Folder, Save Workspace As, open `.code-workspace`, per-folder settings, root folders in Explorer, Search, SCM, terminals and tasks | `docs/editing/workspaces/multi-root-workspaces.md` | ✅ `workspace.svelte.ts`, `workspaceFolders.ts`, `workspaceFile.ts` | – |
| Open Workspace Configuration File | `workspaceActions.ts` | 🆕³ `layoutControls.svelte.ts` | P1-c |

## 8.5 Output panel

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Output channels picker, Clear Output, Toggle Auto Scroll, Toggle Output ⇧⌘U, open log file | `contrib/output` | ✅ `lib/output/*` | – |

## 8.6 Status bar

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Branch and sync, problems, selection / Ln-Col (Go to Line), indentation, encoding, EOL and language pickers, notifications, debug, column selection and overtype items; hide items from the context menu; Toggle Status Bar Visibility | `browser/parts/statusbar`, `editorStatus.ts` | ✅ `StatusBar.svelte`, `statusEntries.svelte.ts` | – |
| Keyboard navigation inside the status bar: Focus Status Bar, ← / ↑ previous, → / ↓ next (wrapping), Home / End, Escape back to the editor (`workbench.statusBar.*`) | `statusbarActions.ts:60-140` | 🆕³ `layoutControls.svelte.ts` `focusStatusBarItem`, `StatusBar.svelte` | P1-c |

## 9. Biggest remaining gaps (do next)

The five gaps from the first round (🆕²) and their leftovers (🆕³) are done. What is left:

None in the P0 areas (🆕⁴ closed the last two: undo of a permanent delete, and the Windows key of Save without Formatting).

---

# P1 areas: tasks, Problems, debugger, settings and keybindings

- **Date:** 2026-11-13
- **References:** VS Code `src/vs/workbench/contrib/{tasks,markers,debug,preferences}/**`, `extensions/typescript-language-features` (problem matchers); docs `docs/editor/tasks*.md`, `docs/debugtest/debugging*.md`, `docs/configure/settings.md`, `docs/configure/keybindings.md`.
- **Method:** each row was checked by searching the Kingu sources for the VS Code command id, setting or `tasks.json` / `launch.json` property. Rows marked "checked end to end" were run against real tools (see 14).
- **Status and priority** as above. P1-a = do next, P1-b = soon, P1-c = rare.

## 10. Tasks

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| `.vscode/tasks.json` 2.0.0: `shell` / `process` tasks, `command` + `args` with quoting, `options` (cwd, env, shell), `osx` / `linux` / `windows` overrides, `detail`, `hide`, `icon`; the `.code-workspace` file's tasks; multi-root folders | `common/taskConfiguration.ts` | ✅ `tasks/taskConfig.ts`, `tasksFile.ts`, `folders.ts`, `commandLine.ts` | – |
| `dependsOn` (parallel, or `dependsOrder: sequence`), cycles reported | `browser/terminalTaskSystem.ts` `_executeDependencyTask` | ✅ `tasks/dependencies.ts` | – |
| `${…}` variables, `inputs` (promptString, pickString, command) | `configurationResolver` | ✅ `tasks/variables.ts`, `inputPrompter.svelte.ts` | – |
| Problem matchers: `$tsc`, `$tsc-watch`, `$eslint-stylish`, `$eslint-compact`, `$gcc`, `$msCompile`, `$go`, `$rustc`, `$jshint`, custom inline matchers, multi-line `loop` patterns, `fileLocation`, background `beginsPattern` / `endsPattern` | `common/problemMatcher.ts`, `problemCollectors.ts` | ✅ `tasks/problemMatcher.ts`, `problemCollector.ts` (`$tsc`, `$gcc`, `$eslint-stylish` checked end to end) | – |
| Run Task, Run Build Task ⇧⌘B, Run Test Task, Rerun Last, Restart / Terminate / Show Running, Configure Task / Default Build Task, Open Workspace Tasks, Show Task Log | `browser/task.contribution.ts`, `abstractTaskService.ts` | ✅ `tasks/taskCommands.svelte.ts` | – |
| Output in a panel terminal with VS Code's naming and reuse (`presentation`: reveal, focus, panel shared / dedicated / new, group, clear, echo), "Terminal will be reused by tasks" message | `terminalTaskSystem.ts` | ✅ `tasks/tasks.svelte.ts`, `taskOutput.ts` | – |
| Detected tasks: npm scripts, cargo, go | `extensions/npm`, rust-analyzer, vscode-go task providers | ✅ `tasks/detect.ts` | – |
| `runOptions.runOn: folderOpen` with trust, `instanceLimit` / `instancePolicy` | `runAutomaticTasks.ts` | ✅ | – |
| `task ` quick-open prefix | `tasksQuickAccess.ts` | 🆕² (see §7) | P1-b |
| User tasks: Open User Tasks (`workbench.action.tasks.openUserTasks`), a tasks.json in the profile folder offered in every folder (source "User") | `task.contribution.ts` | 🆕 `tasks/userTasks.ts`, Rust settings scope `tasks` (`settings.rs`) | P1-c |
| Run Task by name: `workbench.action.tasks.runTask` with keybindings.json `args` (a label, `{ "task": … }` or a task identifier); an unknown name warns and opens the picker | `abstractTaskService.ts` `runTaskCommand` | 🆕 `tasks/taskCommands.svelte.ts`, `userTasks.ts` `taskArg` | P1-c |

## 11. Problems panel

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Problems ⇧⌘M fed by LSP diagnostics and task problem matchers (one owner per matcher, replaced per run) | `contrib/markers/browser/markersView.ts` | ✅ `lsp/ProblemsView.svelte`, `tasks/tasks.svelte.ts` (`MarkerStore` → `lsp`) | – |
| F8 / ⇧F8 next / previous problem across files (`editor.action.marker.nextInFiles`), ⌥F8 in file, `problems.sortOrder` | `editor/contrib/gotoError` | ✅ Monaco's own action, other files through `registerEditorOpener` (`lsp/lsp.svelte.ts`), palette entries via `editorActions.svelte.ts` | – |
| Filter box (text, `!exclude`, errors / warnings / infos, active file), tree / table, copy, open to side ⌘↵, status bar counts | `markersViewActions.ts` | ✅ `lsp/problemsCommands.svelte.ts`, `problemsFilter.ts` | – |

## 12. Debugger (Debug Adapter Protocol)

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| DAP transport: one adapter process per session, `Content-Length` framing, stdio or TCP; adapter lookup and install (pip / brew / pinned js-debug download with SHA-256) | `debug/node/debugAdapter.ts` | ✅ Rust `src-tauri/src/dap.rs` | – |
| Adapters: debugpy (`python` / `debugpy`), js-debug (`node`, `pwa-node`, `node-terminal`, `chrome`, `msedge`), Go `dlv dap`, `lldb-dap`. New adapters plug in through `adapter_for` in `dap.rs` plus defaults in `debug/launch.ts` | debug extensions | ✅ (debugpy checked end to end) | – |
| `.vscode/launch.json`: launch / attach, `${…}` variables, `compounds`, `preLaunchTask` / `postDebugTask`, `serverReadyAction`, Add Configuration, schema completion | `debugConfigurationManager.ts` | ✅ `debug/launch.ts`, `launchSchema.ts`, `serverReady.ts` | – |
| Breakpoints in the gutter (click, right-click menu), conditional, hit count, logpoints, triggered, inline (⇧F9), function, data, exception filters, instruction; enable / disable / remove all, Activate Breakpoints | `breakpointEditorContribution.ts`, `breakpointsView.ts` | ✅ `debug/editorDebug.ts`, `breakpoints.ts`, `DebugView.svelte` | – |
| F5 start / continue, ⌃F5 run without debugging, ⇧F5 stop, ⇧⌘F5 restart, F6 pause, F9 toggle, F10 / F11 / ⇧F11 step, ⌘F11 step into target, run / jump to cursor, step back | `debugCommands.ts` | ✅ `debug/debug.svelte.ts` | – |
| Variables (set value, copy value, lazy), Watch, Call Stack (several sessions, restart frame), Loaded Scripts, debug hover, inline values, Disassembly, Memory | `variablesView.ts`, `watchExpressionsView.ts`, `callStackView.ts` | ✅ `DebugView.svelte`, `hover.ts`, `DisassemblyView.svelte`, `MemoryView.svelte` | – |
| Debug Console: evaluate in the selected frame, history, adapter completions, collapsing of identical lines | `repl.ts` | ✅ `debug/DebugConsole.svelte` | – |
| Debug Console ⇧⌘Y (toggles: shows and focuses the input, hides the panel when already in front; Keep Chat Edits keeps ⇧⌘Y while it applies) | `debug.contribution.ts:448` | 🆕 `debug.svelte.ts` | P1-a |
| Clear Console ⌘K (macOS, focus in the Debug Console) | `repl.ts` `clearReplAction` | 🆕 `debug.svelte.ts`, `DebugConsole.svelte` | P1-b |
| Debug toolbar, status bar item, JavaScript Debug Terminal, Node auto attach | `debugToolBar.ts`, js-debug | ✅ `DebugToolbar.svelte`, `autoAttach.ts` | – |
| `debug ` quick-open prefix | `debugQuickAccess.ts` | 🆕² (see §7) | P1-b |
| Debug Console filter (`text, !exclude`; ⌘F with focus in the console, Escape clears) | `repl.ts` `repl.action.filter` | 🆕 `DebugConsole.svelte`, `debugViewKeys.ts` `replFilter` | P1-c |
| Debug Console: Focus Find ⌥⌘F (`repl.action.find`: matches highlighted, ↵ / ⇧↵ next / previous, n of m, Escape back to the input), Focus Next / Previous Debug Console ⇧⌘] / ⇧⌘[ (Ctrl+PageDown / PageUp elsewhere, with focus in the console, wrapping), Select Debug Console with several sessions | `repl.ts`, `debugCommands.ts` `changeDebugConsoleFocus` | 🆕⁴ `DebugConsole.svelte`, `debug/replFind.ts`, `debug.svelte.ts` `focusConsole` | P1-c |
| Keyboard actions in the debug views: rows take focus; ↑ / ↓ / Home / End move; Breakpoints: Space toggles, ↵ opens, ⌘↵ opens to the side, F2 edits, ⌘⌫ (Delete) removes; Variables: F2 (↵ on macOS) sets the value, ⌘C copies, → / ← expand / collapse; Watch: F2 (↵ on macOS) edits the expression, ⌘⌫ removes, ⌘C copies the value | `breakpointsView.ts`, `variablesView.ts`, `watchExpressionsView.ts` | 🆕 `debug/debugViewKeys.ts`, `DebugView.svelte`, `debug.svelte.ts` `editWatch` (Copy as Expression has no key, as in VS Code: `debug.copyEvaluatePath` is a command and a context menu item only) | P1-c |

## 13. Settings and keyboard shortcuts

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Settings UI ⌘, over settings.json: search (`@modified`, `@id:`, `@lang:`, `@tag:`), User / Workspace / Repository tabs, table of contents, reset, copy as JSON, validation, language overrides, profiles; `workbench.settings.editor: json` | `contrib/preferences/browser/settingsEditor2.ts` | ✅ `settings/SettingsPage.svelte`, `SettingsEditor.svelte`, `registry.ts` | – |
| Open Settings with a query (`workbench.action.openSettings` with a string or `{ "query" }` argument from keybindings.json) | `preferences.contribution.ts` | 🆕 `settings/contributions.ts`, `systemSettings.svelte.ts` | P1-b |
| Open User Settings, Open Workspace Settings (UI on that tab) | `workbench.action.openGlobalSettings`, `openWorkspaceSettings` | 🆕 `settings/contributions.ts` | P1-b |
| Open User / Workspace Settings (JSON), Open Keyboard Shortcuts (JSON), language-specific settings | `preferences.contribution.ts` | ✅ `settings/contributions.ts` | – |
| Keyboard Shortcuts editor: every command with key, when and source; search by text, `@source:`, `@command:`, recorded keys (⌥⌘K); add / change / remove / reset; edit `when`; same-key list; writes keybindings.json, which is watched and applied at once | `keybindingsEditor.ts` | ✅ `settings/pages/ShortcutsPage.svelte`, `workbench/keybindingsEditor.ts`, `keybindings.svelte.ts` | – |
| Open Keyboard Shortcuts ⌘K ⌘S | `preferences.contribution.ts` | 🆕 key in `Workbench.svelte` (the command had no key) | P1-a |
| Default Settings (JSON) and Default Keyboard Shortcuts (JSON), read-only, generated from the registries (every setting with its description and default by group; this platform's default keys with layout notes, then the commands without a key) | `openRawDefaultSettings`, `openDefaultKeybindingsFile` | 🆕 `settings/defaultsJson.ts`, `resources.ts`, `contributions.ts`; read-only in `EditorHost.svelte`; 🆕⁴ tabs named as VS Code's (`defaultSettings.jsonc`, "Default Keybindings") in `editorLabel.ts` | P1-c |
| Settings Sync | `userDataSync` | ✗ (out of scope: needs the server) | P2 |

## 14. How the P1 rows were checked

- **Debugger, end to end:** Kingu's `DapClient` + `DebugSession` drove a real debugpy 1.8 adapter (`python -m debugpy.adapter`, stdio): breakpoint on a line, stop with reason `breakpoint`, locals in the Variables scope, `evaluate` in the frame, Step Over to the next line with the new local, continue to the end with the program output. The Tauri window itself (gutter clicks, views) was not driven.
- **Problem matchers, end to end:** real output of `tsc --pretty false`, `gcc`/clang and `eslint` (stylish) went through `StartStopCollector` with `$tsc`, `$gcc` and `$eslint-stylish`, and gave the expected file, line, severity and message.
- **Unit tests:** `debug/debugViewKeys.test.ts` (row keys per platform, list moves, the console filter), `settings/defaultsJson.test.ts` (both files parse as JSONC; every setting's default is there), `tasks/userTasks.test.ts` (Run Task args, user task ids and source); `settings.rs` tests the `tasks` scope.
- **Keymap:** `keymapAudit.test.ts` passes with the new keys (⌘K ⌘S, ⇧⌘Y; ⌘K Clear Console is exclusive with the terminal's Clear by focus).

## 15. Biggest remaining P1 gaps

None left from the earlier list (🆕⁴): the `task ` / `debug ` prefixes were already done in §7 (🆕²); the Debug Console has find and console switching; Copy as Expression has no key in VS Code either (`variablesView.ts` registers `debug.copyEvaluatePath` without a keybinding), so nothing should take ⌥⌘C from Copy Path of Active File; the default JSON tabs carry VS Code's names. Out of scope on purpose: Settings Sync and the extension marketplace.

## 16. Agent sandbox on Linux and Windows (2026-11-23)

The sandbox for the commands Kingu runs itself (Arkai's Bash; `chat.agent.sandbox.*`, off by default) had only a macOS backend. This round adds Linux and makes Windows refuse clearly. The rest of the sandbox (settings, masking, domain lists, the retry prompt) is in docs/ADE-PARITY.md item 7.

What VS Code does, read in its source:

- **Which systems.** `src/vs/platform/sandbox/common/settings.ts` `isTerminalSandboxSupported` returns false for Windows. The setting text (`src/vs/workbench/contrib/terminalContrib/chatAgentTools/common/terminalChatAgentToolsConfiguration.ts`, `agentSandbox.enabledSetting2`) says "The Local harness supports sandboxing on Linux and macOS only. The Copilot Agent Host harness uses the SDK runtime's sandbox, including on supported Windows hosts". On Windows, `terminalSandboxEngine.ts` `_isSandboxConfiguredEnabled` then reports the sandbox as off, and commands run without it.
- **Linux.** The Local harness writes a settings file and runs `@vscode/sandbox-runtime`'s CLI (`src/vs/platform/sandbox/common/terminalSandboxEngine.ts` `wrapCommand`, `_createSandboxConfig`, with `denyRead` set to home and `allowRead` / `allowWrite` filled from `_updateDenyReadPathsWithHome` and `_updateAllowReadPathsWithAllowWrite`). Before it runs, it checks for `bwrap` and `socat` and probes bwrap with `--unshare-net --dev-bind / / echo ok` (`src/vs/platform/sandbox/node/sandboxHelper.ts` `checkSandboxDependenciesWith`, `_probeBubblewrap`). If the probe fails and `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is 1, it suggests lifting that restriction. It also offers an install command for each distribution. On Linux, each tool's read list uses the XDG cache folders (`terminalSandboxReadAllowList.ts`, the `OperatingSystem.Linux` cases).
- **The runtime's mounts.** These come from `@vscode/sandbox-runtime` 0.0.1 as shipped in VS Code's `node_modules`, `dist/sandbox/linux-sandbox-utils.js`, which is not in the vscode tree. `--ro-bind / /`, then `--bind` for writable paths. A `--tmpfs` covers each denyRead folder, and allowRead paths are bound back with `--ro-bind`. `/dev/null` is mounted over a denied file. For a missing deny path inside a writable folder, `/dev/null` or an empty folder is mounted at its first missing part, and that mount point is removed after the command. `.git/hooks` is skipped when `.git` is not a folder. The command gets `--unshare-net` plus `socat` bridges to the host proxy on ports 3128 and 1080, `--unshare-pid --proc /proc`, `--new-session` and `--die-with-parent`, and the `apply-seccomp` filter against new Unix sockets. WSL 1 is unsupported (`sandbox-manager.js` `isSupportedPlatform`).

What Kingu does:

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Linux backend: bubblewrap with the same policy as the macOS profile (writes only in the working folder, the run's `TMPDIR`, a worktree's git dirs and read/write paths; home hidden except readable folders; git hooks and config and read-only paths read-only; denied paths emptied) | sandbox runtime `generateFilesystemArgs` | 🆕 `agent-host/src/sandbox/linux.ts` `linuxMounts`, `linuxArgv`; `run.ts` `RunSandbox.launch` | P1 |
| Missing paths blocked from being created; mount points removed once the last running command ends | `cleanupBwrapMountPoints` (deferred while sandboxes run) | 🆕 `removeMountPoints`, `Launch.done` (called by `arkai/tools.ts`) | P1 |
| Network off: own namespace; domain lists: the run's proxy through a Unix socket and `socat` inside, on the proxy's own port, so `HTTP(S)_PROXY`, `ALL_PROXY` and `GIT_SSH_COMMAND` from `proxy.ts` work unchanged | `initializeLinuxNetworkBridge`, `buildSandboxCommand` | 🆕 `ProxyBridge` (host side in-process, not a second socat), `linuxArgv` | P1 |
| Missing bwrap, bwrap that cannot create namespaces (AppArmor hint), missing socat when a domain list applies, WSL 1: clear error, command not run | `sandboxHelper.ts`, `isSupportedPlatform` | 🆕 `profile.ts` `sandboxBackend`, `linux.ts` `probeBwrap`, `bwrapMissing`, `socatMissing` | P1 |
| Per-tool read lists for Linux (`~/.cache/...`) | `terminalSandboxReadAllowList.ts` | 🆕 `reads.ts` `LINUX`, `commandGrants(command, platform)` | P1 |
| Windows | Local harness: no sandbox, so the setting acts as off | **differs on purpose**: Arkai refuses the command ("not supported on Windows") and runs it outside only after the user approves that command (`allowUnsandboxedCommands`). A run that asked for the sandbox never runs a command bare silently | – |

Differences and gaps:

- **No seccomp filter.** The runtime blocks `socket(AF_UNIX)` with a seccomp filter; Kingu does not, so local daemons' sockets stay reachable (the macOS profile also allows Unix sockets). With the network off, only the resolver daemons' socket folders are hidden (`/run/systemd/resolve`, `/run/nscd`), matching the macOS profile's mDNSResponder rule. D-Bus to systemd-resolved stays open.
- **No dotfile scan.** The runtime's ripgrep scan, which makes nested `.git/hooks` and dotfiles such as `.bashrc` and `.mcp.json` read-only, is not built.
- **`allowLocalNetwork` reaches less on Linux.** With the network off, it means the sandbox's own loopback, not the host's. Opening the host's loopback would need a shared network namespace, which would open all of the network.
- **Executable lookup.** `bwrap` and `socat` are looked up in system folders only (`/usr/bin`, `/bin`, `/usr/local/bin`, `/usr/sbin`, `/run/current-system/sw/bin`), not on PATH: a writable PATH folder could hold a fake `bwrap`. VS Code uses `findExecutable` on PATH.
- **No install button.** The error lists apt / dnf / pacman commands.
- **Not run on Linux.** No Linux machine was available. `test/sandbox-linux.test.ts` (run on macOS) checks the mount arguments and their order, the argv with and without the bridge, refusals, mount-point cleanup and a real request through the bridge to the proxy. bwrap itself, the `--remount-ro` and `--ro-bind-try` behavior, socat inside the namespace and the AppArmor message have not been run.
- The Claude runtime uses the Agent SDK's own sandbox (bubblewrap on Linux, `failIfUnavailable`), not this backend.

## 17. Inbox mode (VS Code 1.146) and cron schedules (VS Code 1.145) (2026-11-24)

Scope from `docs/APP-CHECK-orca-vscode-cursor-2026-11-24.md` (VS Code 1.143.1 → 1.147.0). Read in the VS Code source at `2219f59cf7c` (2026-11-23) and the vscode-docs pages named below. Orca's "Needs you" (1.4.272) is the ADE side, in MECHANICS.md.

### Inbox mode

What VS Code does:

- **Setting.** `sessions.list.inboxEnabled`, boolean, experimental, off by default (`src/vs/workbench/contrib/sessions/browser/sessionsConfiguration.ts`). On, it adds **Grouping > Inbox Mode** to the Agents window's sessions list (vscode-docs `docs/agents/run/sessions/organize-sessions.md` "Triage sessions with Inbox mode"; release notes `v1_146.md`).
- **Sections.** Inbox, Working, On hold, Acknowledged, in that order; Pinned above (`src/vs/workbench/contrib/sessions/common/sessionInbox.ts` `SessionInboxSection`, `sessionInboxSections`; `src/vs/sessions/SESSIONS_LIST.md` "Inbox grouping"). A session that is working stays in Working, even when another of its chats needs input (`getSessionInboxSection`). Inbox holds questions, approvals, errors and completed responses to review. Acknowledged starts collapsed. An empty Inbox shows a message; empty secondary sections are left out.
- **Priority.** Now for needs-input (and failing checks / review comments), Next, Later; then created or updated time (`src/vs/workbench/contrib/sessions/common/sessionAttentionService.ts` `InboxNotificationPriority`; `browser/sessionAttentionService.ts` `collectSessionNotifications`).
- **Triage.** Dismiss from Inbox (to Acknowledged until new activity), Put on Hold (until resumed), Snooze (10 minutes, 30 minutes, one hour, tomorrow 9:00, one week at 9:00, until new activity, or a date), Return to Inbox, Undo. None of them stops, archives or answers the session. New activity ends a dismissal or an "until activity" snooze; a timed snooze ends at its time; triage survives reloads and is profile-local (`sessionInbox.ts` `SessionInboxState`, `isSessionInboxStateCurrent`; `src/vs/workbench/contrib/sessions/browser/views/sessionsListActions.ts` the Snooze picks; `SESSIONS_LIST.md` on `ISessionsListModelService`).
- **History cutoff.** Completed sessions from before attention tracking first started are excluded (`SESSIONS_LIST.md`).

What Kingu does:

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| `sessions.list.inboxEnabled` (off by default) shows Inbox | `sessionsConfiguration.ts` | 🆕 `settings/vscode/agentSessions.ts`; an **Inbox** entry in the Agents side bar with the Inbox count, and **Agents: Show Inbox** in the palette (both behind the setting) | P1 |
| One list across every agent | sessions of all providers and workspaces | 🆕 `ade/sessionInbox.svelte.ts`: tasks of the open folder (`adeTasks.views`: the task's CLI hooks, its terminal panes, its agent-host run) and of every other added project (`projects.all`), chats of every folder (`chats.runs`), and agent CLIs in SSH terminals (`sshProjects.agents`, `remoteAgentStatus`) | P1 |
| Sections, order, priority, empty message, Acknowledged collapsed | `sessionInbox.ts`, `sessionAttentionService.ts` | 🆕 `ade/sessionInbox.ts` `sectionOf`, `buildInbox`, `priorityOf`; `ade/InboxPage.svelte` | P1 |
| Dismiss, Put on Hold, Snooze (VS Code's six picks), Return to Inbox, Undo; kept across reloads | `sessionsListActions.ts`, `isSessionInboxStateCurrent` | 🆕 `isTriageCurrent`, `snoozeChoices`, `snoozeState`; triage in localStorage (`kingu.sessionInbox.triage`), per machine | P1 |
| History cutoff | first tracking start, persisted | ◐ a chat's run counts only when it ran in this app session (a transcript replayed after a restart is history); tasks follow their board status, so a finished task stays "Ready to review" until it is done or dismissed | – |
| Pinned, Ready to merge (PR checks), Fix Checks / Address Comments, Snooze to a picked date, auto-advance (`sessions.list.inboxAutoAdvance`), multi-select | `sessionAttentionService.ts`, `sessions.list.inlineActions` | ✗ not built | P2 |
| Fold of a long Inbox | – (VS Code lists all) | Orca's fold (approvals first and never hidden, five rows, "Show N more"): MECHANICS.md | – |
| **Kingu only:** Allow / Deny on an Inbox row | – (VS Code opens the session to approve) | 🆕 a chat's or an agent-host task's own permission prompt is answered once from its row (`InboxEntry.answer`, `agent_answer_permission`, the same call as the chat card's Allow / Deny). "Always" choices, questions, terminal prompts and SSH asks still open where they were asked | – |

### Cron schedules for local automations

What VS Code does:

- **Settings.** `chat.automations.enabled` (boolean, on by default, MACHINE scope): off hides Automations and stops dispatching scheduled runs (`src/vs/sessions/contrib/automations/browser/automations.contribution.ts`).
- **Trigger.** Manual, Hourly, Daily, Weekly, Cron; the agent host's presets also include Weekdays. Every preset becomes a five-field cron expression in the machine's IANA zone with misfire policy `runOnce`; Hourly fires at the minute it was saved (`src/vs/workbench/contrib/sessions/providers/agentHost/browser/agentHostAutomationStore.ts` `scheduleTrigger`; `src/vs/workbench/contrib/chat/common/automations/automation.ts` `AutomationInterval`). A saved Cron stays Cron even when it matches a preset; new cron schedules use the local zone and an edited one keeps its saved zone (vscode-docs `docs/agents/run/automations.md` "Use a cron schedule").
- **Grammar and description.** Exactly five fields; `*`, lists, ascending ranges, steps on `*` or a range; month and weekday names; 0 and 7 are Sunday; no `5/15`, seconds or `@daily`; both day fields restricted means either matches; a date that can never occur is refused. The form describes the schedule ("Runs at 9:00 AM and 5:00 PM on Monday through Friday.") and keeps Create unavailable while an expression is incomplete or invalid (`src/vs/platform/agentHost/common/automationCron.ts`; `src/vs/sessions/contrib/automations/browser/automationCronInput.ts`: five inputs, a pasted expression fills them, "Evaluated in local time.").
- **Closed at the scheduled time.** Local schedules run only while VS Code (or its Agent Host) runs. Each trigger keeps a cursor at its next occurrence; when it comes due a minute or more late, the run is a catch-up: with `runOnce` one run covers every missed occurrence, with `skip` none runs; the cursor then moves to the next occurrence after now (`src/vs/platform/agentHost/node/agentHostAutomationService.ts` `_claimDueRuns`, `nowTimestamp - scheduledFor >= 60_000`; `src/vs/platform/agentHost/common/state/protocol/channels-automation/state.ts` `AutomationMisfirePolicy`). The docs: "After an interruption, a missed schedule can trigger a catch-up run. Don't rely on every missed occurrence being replayed." One run of an automation at a time.
- **Never without the user.** The New Automation dialog's Enabled box is cleared by default; imported and template automations too (`automations.md`).

What Kingu does:

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| `chat.automations.enabled` | `automations.contribution.ts` | 🆕 `settings/vscode/agentSessions.ts` (user-only, so a repository cannot turn it on); off hides the side bar entry and palette commands and the runner dispatches nothing (`automations.svelte.ts` `featureEnabled`). Kingu's own `kingu.automations.enabled` (Pause All) still applies too | P1 |
| Trigger: Manual, Hourly, Daily, Weekdays, Weekly, Cron | `scheduleTrigger` | 🆕 `ade/automationCron.ts` `presetExpression`, `presetFields`; `AutomationForm.svelte`; saved as `trigger` + `time_zone` in `.kingu/automations.json` (`agent/automations.rs` checks the kind, a five-field shape and an IANA-shaped zone). Kingu's earlier schedule text stays as **Custom** (`schedule.ts`) | P1 |
| Cron grammar, description, next occurrence in a zone (DST-correct) | `automationCron.ts` | 🆕 ported in `ade/automationCron.ts` (`parseAutomationCron`, `describeAutomationCron`, `nextAutomationCronOccurrence`), errors and description in Thai too | P1 |
| Cron editor: five inputs, paste fills all, zone line, description, Create unavailable while invalid | `automationCronInput.ts` | 🆕 `AutomationForm.svelte` | P1 |
| Enabled cleared by default | New Automation dialog | 🆕 the form's Enabled box; turning on still asks with Kingu's native confirm, and the consent is per machine and covers the trigger and zone (`consentKey`) | P1 |
| Closed at the scheduled time | one catch-up run (`runOnce`) or none (`skip`), a minute late counts | 🆕 the same rule for triggers (`automations.ts` `decideTrigger`, `CATCH_UP_MS`): Kingu's "Run missed runs when Kingu opens" switch is the misfire policy (on = `runOnce`, VS Code's default). Custom (older) schedules keep Kingu's 5-minute grace | P1 |
| One run at a time | `_claimDueRuns` | ✅ a due run is skipped while the previous run's task works | – |
| Disabled automations in a collapsed section | release notes `v1_145.md` | 🆕 `AutomationsPage.svelte` | P2 |
| Workspace custom agents, `.automation.md` import / export, templates, cloud automations, run history list | `automations.md` | ✗ not built (a run is a task; the card links its latest one) | P2 |

Tests: `ade/automationCron.test.ts` (grammar and VS Code's messages, zones, DST gap, Feb 29, either-day rule, description strings, presets, paste), `ade/automations.test.ts` "VS Code triggers" (on time, a zone, one catch-up for many missed, `skip`, one at a time, no backlog, Manual), `ade/sessionInbox.test.ts`, Rust `agent::automations` (trigger and zone round-trip, an older file written back unchanged, bad kinds, shapes and zones refused), E2E `e2e/inbox-automations.spec.ts`.

Not verified in the running app: a scheduled run firing at its time and the catch-up after quitting and reopening Kingu (the unit tests drive `decide` with fixed clocks); the Inbox with a real chat run and a real SSH host.

## 18. Agent features from VS Code 1.145–1.147 for Arkai (2026-11-24)

Scope: the 1.145–1.147 rows of docs/APP-CHECK-orca-vscode-cursor-2026-11-24.md that apply to Kingu's own agent (Arkai, `apps/agent-host/src/arkai`) and its MCP client: MCP app tools (1.145), Skills over MCP (1.146) and model routers (1.147). The managed MCP allowlist and the sandbox retry are another round's.

What VS Code does, read in its source (`/Users/bright/src-ref/vscode` at `2219f59c`, and `vscode-docs/release-notes/v1_145.md`, `v1_146.md`):

- **Skills over MCP.** The setting is `chat.agentHost.mcpSkills.enabled`, default on (`src/vs/platform/agentHost/common/agentHostStarter.config.contribution.ts`). Discovery and loading run inside the Copilot runtime, which is not in the tree. VS Code handles the parts around it:
  - **Consent.** The runtime's prompt is parsed in `src/vs/platform/agentHost/node/copilot/copilotMcpSkillConsent.ts`. `copilotAgentSession.ts` `_handleMcpSkillConsentRequest` and `_getMcpSkillServerApproval` ask once per server ("Allow Skills from {0}?"). The answer is allow once, allow always (`chat.agentHost.mcpSkills.serverApprovals`) or not now. Autopilot declines.
  - **Names.** A skill is `<server>:<skill>` (`common/agentHostCustomizationUri.ts` `getMcpSkillName`).
  - **Listing.** Skills are listed under their server (`node/shared/mcpCustomizationController.ts` `IMcpSkill`, `_buildSkills`), cached per session (`node/shared/mcpSkillCache.ts`), and invoked as slash commands (`_rewriteMcpSkillReferences`).
  - **The protocol.** It is SEP-2640, `io.modelcontextprotocol/skills` (modelcontextprotocol.io/seps/2640-skills-extension). The server declares `capabilities.extensions`. Entries come from `skills/list` and `skills/get`. Each entry has `uri`, `frontmatter` and `resources`: `{uri, digest: "sha256:…", size}` for every file, or `"dynamic"`. Files are read with `resources/read`.
- **MCP app tools.** An MCP App, a `ui://` view that a tool renders in chat, can register tools with ext-apps `App.registerTool()`. The chat publishes them as session tools for the next request (`src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostMcpAppToolsService.ts`). Tool metadata (`src/vs/platform/mcp/common/modelContextProtocolApps.ts` `McpUiToolMeta`) has `resourceUri` and `visibility: ("model" | "app")[]`. An `["app"]` tool is for its app only.
- **Model routers.** A router is a `<name>.model-router.yaml` file in `~/.agents/model-routers/`. It is offered as the model `model-router:<name>` when `chat.copilot.modelRouter.enabled` is on (default off). The pieces are in `src/vs/platform/agentHost/`:
  - **File format.** `common/modelRouter.ts` `parseModelRouter`: version, name, display-name, description, effort (`auto` / `off` / a level), context-size, switching (`first-turn` / `auto`), guidance, and 2–10 routes, each with `model`, `when`, `examples`, `effort`, `name` and `guidance`.
  - **Model references.** `matchModelFamily` resolves a family such as `opus` to its newest model.
  - **Routing policy.** `node/copilot/copilotModelRouter.ts`: confidence at least 0.4 on the first turn, otherwise the first route. To switch, a follow-up needs probability at least 0.6 and a lead of at least 0.25, with a 2-turn cooldown. Continuation messages and an effort margin of 0.75 keep the current route.
  - **Guidance.** `common/modelRouterGuidance.ts` gives the main agent `<model_router_guidance>`.
  - **The decision.** The decision model is Copilot's (`gpt-6-luna-decisions`, through `decisions.ask`; `copilotModelRouterPicker.ts`).

What Kingu does:

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Skills over MCP: the client declares the extension; a declaring server's `skills/list` (all pages) is read when it connects, and nothing else is fetched until a skill is loaded | runtime; `mcpCustomizationController.ts` | 🆕 `arkai/mcp.ts` `clientCapabilities`, `McpHub.start`; `arkai/mcpSkills.ts` `listSkills` | P1 |
| Entries checked as SEP-2640 asks: the last path segment is the name, `resources` complete and inside the skill, `sha256:` digests, 512 files / 16 MiB; bad ones are refused and counted | SEP-2640 "Skill entry", "Limits" | 🆕 `mcpSkills.ts` `skillEntry` | P1 |
| The model sees each skill's `<server>:<name>`, description, server and URI in its own section, apart from local skills and marked as server data; a name clash within a server is told apart by path | `getMcpSkillName`; SEP-2640 "Names", "Presenting" | 🆕 `mcpSkillIndex`, `skillLabels`; `arkai/session.ts` `system` | P1 |
| Loading a skill: a `ReadSkill {server, uri}` tool. A load asks "Allow skills from <server>?" (Allow / Always for this run / Deny), in every permission mode; Allow all declines, as Autopilot does | `_handleMcpSkillConsentRequest` | 🆕 `session.ts` `skillConsent`, `ruleFor` (`ReadSkill(server:…)`) | P1 |
| SKILL.md and every other file are checked for size and digest, and the front matter is compared field by field with the entry; reads are bound to the server the skill came from, and to the files its entry lists; a folder is answered from the entry's list; `skills/get` for a URI no listing named | SEP-2640 "Integrity and verification", "Cross-server reads" | 🆕 `McpSkillRegistry.read` | P1 |
| `/<server>:<skill>` in the chat: offered as a session command, and the message tells the model to load that skill | `_rewriteMcpSkillReferences`, skill completions | 🆕 `session.ts` `emitSkillCommands`, `withSkillInvocation` (the composer's `/` list shows them through the existing `commands` event) | P1 |
| `chat.agentHost.mcpSkills.enabled` (default on) | same | 🆕 `settings/vscode/chat.ts`; Rust `agent/mod.rs` sends `mcpSkills: false` only when it is off; agent-host `host.ts` | P1 |
| MCP Apps: a tool whose `_meta.ui.visibility` (or `_meta["ui/visibility"]`) leaves out `model` is not offered to the model | `McpUiToolMeta.visibility` | 🆕 `mcp.ts` `modelVisible` | P1 |
| MCP app tools (tools an app view registers) | `agentHostMcpAppToolsService.ts` | 🆕 built with the MCP Apps renderer: see "MCP Apps in the chat" below | P1 |
| Model routers: the file format and its errors and warnings, as VS Code checks them | `parseModelRouter` | 🆕 `arkai/modelRouter.ts` `parseModelRouter` (YAML read by `Bun.YAML`, so not VS Code's strict subset check) | P1 |
| Routes resolved to the run's provider: an exact id (dots or dashes), `<provider>/<id>`, or a family (`opus`); a route with no model there is skipped | `resolveModelRouter`, `matchModelFamily` | 🆕 `matchModel`, `resolveModelRouter` (one provider: an Arkai run has one) | P1 |
| Routing policy: first-turn pick and fallback, the follow-up switch thresholds and cooldown, continuations, effort from the route or the decision (`none` is off, `ultra` is max) | `copilotModelRouter.ts` | 🆕 `routeTurn`, `decideModelRouterSwitch`, `decideModelRouterEffort`; `session.ts` `routeThisTurn` | P1 |
| Route guidance for the main agent | `modelRouterGuidance.ts` | 🆕 `modelRouterBriefing`, added after the system prompt | P1 |
| The decision | Copilot's decisions model | **differs**: Copilot-only. Kingu asks the router's first model at the user's own provider for JSON probabilities (and effort 0–4), with VS Code's framing, with a 15-second limit (VS Code's is 5 s on a hosted service) | P1 |
| Picking a router: `chat.copilot.modelRouter.enabled` (default off) lists `~/.agents/model-routers/*.model-router.y(a)ml` under every Arkai provider as `<provider>/model-router:<name>`; the chat keeps the router as its model | model picker rows | 🆕 Rust `agent/arkai.rs` `model_routers`, `arkai_model_routers`; `agent/arkai.ts` `parseArkaiRouters`, `arkaiGroups`; e2e `model-router.spec.ts` | P1 |
| **Kingu-only:** when the decision model cannot answer (offline, a provider error, a timeout), the route is picked by the words of the request against each route's `when` and `examples`; only when nothing matches does the turn fall back to the first route, as VS Code always does | – (VS Code: first route) | 🆕 `modelRouter.ts` `keywordPick`, `ask` | P1 |

Skipped, and why:

- **Persisted skill approvals.** VS Code's `chat.agentHost.mcpSkills.serverApprovals` is not built. Arkai keeps no rules file, so "Always" lasts for the run, like its other grants.
- **A skill cache and a Skills tab entry.** Skill files are fetched each time they are read. The skills appear in the `/` list, not in a customizations editor.
- **Dynamic skills.** Skills with `"resources": "dynamic"` are loaded, but their content cannot be verified, and the tool result says so.
- **Router parts that need Copilot.** These are left out: `context-size` (an Arkai model has one window, so the value is checked and ignored), the built-in `/model-router` skill, the facts VS Code sends with the decision (attachments, repository, PR state), and the router notices in the chat. A failed decision is logged. A missing or broken router fails the turn with the reason.
- **Routes across providers.** An Arkai run talks to one provider, so routes that name another provider's models are skipped.

Tests: agent-host `test/arkai-mcp-skills.test.ts` and `test/model-router.test.ts` include whole runs against a fake MCP server and a fake model. Desktop `src/lib/agent/arkai.test.ts`, Rust `arkai::router_tests`, and e2e `e2e/model-router.spec.ts` cover the rest.

### MCP Apps in the chat (SEP-1865) (2026-11-24)

What VS Code does (`/Users/bright/src-ref/vscode`):

- **Rendering.** `src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppModel.ts` (`ChatMcpAppModel`) and `chatMcpAppSubPart.ts` render a tool call's `_meta.ui.resourceUri` under the call when `chat.mcp.apps.enabled` is on (default on; `src/vs/platform/mcp/common/mcpManagement.ts` `mcpAppsEnabledConfig`; read in `mcpLanguageModelToolContribution.ts`). The frame starts at 300 px, is at least 100 px and at most 75% of the window, and follows `ui/notifications/size-changed`.
- **Loading.** `src/vs/workbench/contrib/mcp/browser/mcpToolCallUI.ts` reads the resource (`resources/read`, first content, text or base64 blob, its `_meta.ui`). The MCP client announces `extensions: {"io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]}}` at `initialize` (`mcpServerRequestHandler.ts`).
- **The frame.** It is a webview: an iframe on the webview's own origin (one per server, `WebviewOriginStore`), whose content frame has `sandbox="allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms"` and `allow="cross-origin-isolated; autoplay; clipboard-read; clipboard-write"` (`src/vs/workbench/contrib/webview/browser/pre/index.html`).
- **The policy.** `_injectPreamble` puts a CSP `<meta>` first in `<head>`: `default-src 'none'`, `script-src`/`style-src 'self' 'unsafe-inline' 'unsafe-eval'` + `resourceDomains`, `connect-src 'self'` + `connectDomains`, `img-src`/`media-src 'self' data:` + `resourceDomains`, `font-src 'self'` + `resourceDomains`, `frame-src` `frameDomains` or `'none'`, `object-src 'none'`, `base-uri` `baseUriDomains` or `'self'`. It also adds the wheel hand-off (`ui/notifications/sandbox-wheel`) and rewires `window.parent` to its webview API.
- **The bridge.** `_handleWebviewMessage` answers `ui/initialize` (protocol `2026-01-26`, `hostInfo`, `hostCapabilities`, `hostContext` with VS Code's `--color-*`/`--font-*` style variables), then sends `ui/notifications/tool-input` and, once the call completes, `tool-result`. It handles `tools/call` (only tools whose visibility has `app`, else "Tool not found on server"), `resources/read`, `sampling/createMessage`, `ping`, `ui/open-link` (http and https only), `ui/message` (into an empty input), `ui/update-model-context`, `ui/download-file`, `ui/request-display-mode` (an editor), `ui/notifications/initialized`, `notifications/tools/list_changed` and `notifications/message`; anything else with an id gets -32601.
- **App tools.** An app that declares `appCapabilities.tools` is asked `tools/list` (all pages, 30 s); `agentHostMcpAppToolsService.ts` publishes the tools for the session's next request (the app registered last wins a name) and answers a call with a host-to-app `tools/call`, cancelled with `notifications/cancelled`.

What Kingu does:

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| `chat.mcp.apps.enabled` (default on): a tool call's app renders under it | `mcpAppsEnabledConfig` | 🆕 `settings/vscode/chat.ts`; `agent/ChatList.svelte`, `agent/mcpApps.svelte.ts` `enabled` | P1 |
| The UI extension announced; `_meta.ui` (and the older flat `ui/resourceUri`, `ui/visibility`) read; only `ui://` resources render | `mcpServerRequestHandler.ts`, `mcpServer.ts` | 🆕 agent-host `arkai/mcp.ts` `clientCapabilities`, `uiMeta` | P1 |
| The chat hears of the app when the call is allowed, and again with the server's own `CallToolResult` (null over 1 MB) | `mcpAppData`, `resultDetails.mcpOutput` | 🆕 `arkai/session.ts` `runCall`, `arkai/mcpApps.ts` `appResult`; event `mcp_app` (Rust `events.rs` `McpApp`, kept in the transcript up to 256 KB of result) | P1 |
| The resource read over the run's connection; VS Code's CSP, sandbox and `allow`; the page served on an origin of its own | `_injectPreamble`, webview | 🆕 Rust `src-tauri/src/mcp_app.rs` (`csp`, `prepend_to_head`, `SANDBOX`, `ALLOW`, scheme `kingu-mcp-app:`); `agent/McpAppFrame.svelte` | P1 |
| The bridge: initialize, tool input and result, host context changes (theme, width), size, wheel, links, `ui/message`, server requests, unknown methods | `_handleWebviewMessage` | 🆕 `agent/mcpApp.ts` `McpAppHost` (VS Code's style variables resolved to this window's values, since the frame cannot see the chat's CSS variables) | P1 |
| The app's `tools/call` (app-only tools too), `resources/read`, `sampling/createMessage` | `McpToolCallUI` | 🆕 Rust `agent_mcp_app_request` → agent-host `mcp_app` → `ArkaiSession.mcpApp`. **Kingu-only:** a tool call goes through the run's permission rules (mode, "always" grants, disallowed tools, safety checks, `chat.tools.*.autoApprove`), asked as "The MCP App of <server> wants to run <tool>"; VS Code calls it straight away | P1 |
| Tools an app registers, offered from the next request, the last app winning a name; the model's call answered by the app, cancelled when the turn stops | `agentHostMcpAppToolsService.ts` | 🆕 `mcpApps.svelte.ts` (`agent_mcp_app_tools`, `mcp_app_tool_call` → `agent_mcp_app_tool_result`), `arkai/mcpApps.ts` `AppToolRegistry`, `AppToolCalls` | P1 |
| An app's frame stays when its turn folds into "Worked for" | the part stays | 🆕 `ChatList.svelte` | P1 |
| Fullscreen in an editor (`ui/request-display-mode`) | `ChatMcpAppEditorInput` | **differs**: answered `inline`, and `availableDisplayModes` is `["inline"]` | P2 |
| `ui/download-file`, `ui/update-model-context` | chat response files, input context chips | ✗ not offered at `ui/initialize`; answered `{isError: true}` | P2 |
| Server notifications forwarded to the app (`serverTools.listChanged`) | `onNotification` | ✗ Arkai's MCP client does not pass them on, so `serverTools` and `serverResources` are offered without `listChanged` | P2 |
| Hidden frames kept alive for an app with tools (the last request's and three more) | `MCP_APP_KEEP_ALIVE_APP_COUNT` | **differs**: a frame lives while its row is in the chat list; it takes its tools back when it goes | P2 |
| A stopped server started for its app ("Start Server") | `startServer` | **differs**: the app needs the chat's live Arkai run; otherwise the card says so and offers Retry | P2 |

How an app is kept away from Kingu (Rust `mcp_app.rs` module comment, `McpAppFrame.svelte`):

- **No Tauri IPC.** On macOS and Linux Tauri puts its `__TAURI_INTERNALS__` script and the per-launch invoke key in the main frame only, so the app's frame has no `invoke`, and any IPC message it could post lacks the key Tauri checks first (the same reasoning as artifact previews and snap views). On Windows, where WebView2 puts initialization scripts in subframes too, apps are refused (`SUPPORTED`).
- **Another origin.** The page is served from `kingu-mcp-app://<origin>/<token>/index.html`. `<origin>` is random, one per chat and server (VS Code keeps one per server). `allow-same-origin` keeps the page on that origin, never on the app's own (`tauri://localhost`). So the page cannot read the chat's DOM, storage or cookies, nor another chat's or another server's app. A token is served only on the origin it was opened for. The main window's CSP allows `kingu-mcp-app:` frames (`tauri.conf.json` `frame-src`).
- **The sandbox.** VS Code's flags: scripts, forms, pointer lock and downloads only. No popups, no top navigation, no modals.
- **The policy.** VS Code's CSP from the resource's `_meta.ui.csp`, as the `<meta>` VS Code injects and also as a response header with the frame's `sandbox`. The header holds for markup before the `<meta>` and if the page is opened outside the frame. **Kingu-only:** a domain that names the app's own schemes (`ipc:`, `tauri:`, `asset:`, `kingu-*`, `ipc.localhost`) or contains `;`, `,`, quotes, `<`, `>` or whitespace is dropped.
- **Messages.** The chat takes only messages whose `source` is that app's frame. It answers only the ext-apps methods above, and posts plain JSON back. Links leave only as http(s), in the browser. Server requests go to the run that rendered the app. That run checks the method, the server and the tool's visibility, and applies the permission rules to tool calls (`arkai/mcpApps.ts` `checkAppRequest`).

Tests:

- Agent-host `test/arkai-mcp-apps.test.ts`: metadata, the extension, the hub, a whole run that emits `mcp_app`, the app's call asked and denied, unknown tools and methods refused, app tools offered and answered.
- Desktop `src/lib/agent/mcpApp.test.ts`: the bridge, the host context, links, heights, app tools with paging and cancel, the chat part.
- Rust `mcp_app::tests`: VS Code's policy, dropped domains, the head injection, the resource read, origins per chat and server.
- E2E `e2e/mcp-apps.spec.ts`, with a fake app page: the sandbox and `allow` attributes; no `__TAURI_INTERNALS__` and no access to `parent` or `top` from the app; input and result shown; the frame stays after the turn folds; an app-only call; tool registration and the model's call; the setting off.

Not verified in the running app: a real MCP Apps server (for example an ext-apps example) in a Tauri build, and that WebKit serves `kingu-mcp-app://<origin>/` with a per-host origin. If WebKit gives custom schemes an opaque origin instead, the isolation only gets stricter.

## 19. Send Later and saved chat drafts (VS Code 1.147) (2026-11-24)

What VS Code does (`/Users/bright/src-ref/vscode`):

- **Send Later.** The Send button's menu has Send Later..., with In 5 / 10 / 15 / 30 Minutes, In 1 Hour, In 24 Hours, Tomorrow Morning (9:00) and Choose Date and Time... (`sessions/browser/scheduledChatTimePicker.ts`). The request and its attached context are captured when it is scheduled (`sessions/common/scheduledChatRequest.ts`, `parseScheduledChatTime`), and the agent host's Automations send it. Rows over the input show "Sends in …" or "Today at …" (`chat/browser/widget/chatScheduledRequestTime.ts`), with Send Now, Edit, Reschedule and Cancel Schedule.
- **Saved drafts.** Each session keeps its unsent input text and attachments (`sessions/common/savedSessionDrafts.ts`, `IChatDraft`, `hasSessionDraftContent`). The sessions list has a Drafts group with Resume Draft and Delete Draft.

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| Send Later... in the Send button's menu, with VS Code's presets and a date-and-time choice (this device's time zone; an invalid or DST-skipped time is refused) | `scheduledChatTimePicker.ts`, `parseScheduledChatTime` | 🆕 `src/lib/agent/sendLater.ts` `laterPresets`, `parseLocalDateTime`; `SendLaterPicker.svelte` | P1 |
| The request is captured when it is scheduled, with its attached context | `captureScheduledChatRequest` | 🆕 `AgentPanel.svelte` `scheduleMessage` (`outgoing` runs then) | P1 |
| The "N Scheduled Messages" rows over the input: "Sends in …", hover for the exact time, Send Now, Edit as Draft, Reschedule..., Cancel Schedule | `chatScheduledRequestTime.ts` | 🆕 `ScheduledMessages.svelte`, `sendLater.ts` `relativeLater`, `absoluteLater` | P1 |
| Who sends it | the agent host's Automations | **differs**: Kingu keeps scheduled messages in this machine's localStorage (`kingu.chat.scheduled`). A 15-second timer sends the open folder's due messages into their chat, queued behind a running turn (`sendLater.svelte.ts`). A message whose folder is closed shows "Waiting to send" until the folder is opened. A message whose chat is gone is dropped, with a notification. A failed send is marked "Not sent" and is not retried. Each message is removed from storage before it is sent, so two windows never send it twice. Messages more than 30 days overdue are dropped | P1 |
| **Kingu-only:** `/later <when> <message>`. `<when>` is `10m`, `1h30m`, `14:30`, `9am` or `tomorrow` | – | 🆕 `sendLater.ts` `parseLaterTime`, `parseLaterCommand` | P2 |
| Each chat keeps its unsent input (text, attached files and file chips), across switching chats and restarts | `savedSessionDrafts.ts`, `IChatDraft` | 🆕 `src/lib/agent/chatDrafts.ts` (localStorage `kingu.chat.drafts`, saved after a pause in typing; kept for 30 days, the 50 newest). A sent or cleared draft is dropped | P1 |
| The history marks a chat with a draft ("Draft: …"), opening it resumes the draft, and Delete Draft forgets it | Drafts group, Resume Draft / Delete Draft | 🆕 `AgentPanel.svelte` `historyDrafts`, `deleteDraft` (a badge on the chat's row, not a separate group) | P1 |

Skipped, and why:

- **Scheduling in the agent host.** Kingu's chats run from the window, and nothing would send at the due time with Kingu closed. Scheduled messages stay on this machine. Recurring agent work is handled by Automations (§17).
- **A separate Drafts group.** A draft belongs to a chat that already exists, so the history marks that chat's row and does not list it twice.

Tests: `src/lib/agent/sendLater.test.ts`, `chatDrafts.test.ts`, and e2e `e2e/chat-composer-later.spec.ts` (Send Later from the menu, `/later`, drafts; it also covers Orca's `/btw`, which MECHANICS.md describes).

## 20. Browser tools for chat agents (VS Code 1.147) (2026-11-24)

What VS Code does (`src/vs/workbench/contrib/browserView/electron-browser/`): with `workbench.browser.enableChatTools` on, a chat agent gets browser tools (`tools/`: open, navigate, read, click, type, hover, drag, handle a dialog, screenshot, list pages, run Playwright code). Opening a page and navigating to an address ask first (`prepareToolInvocation`, `confirmationMessages` with `allowAutoConfirm`). An agent works on pages it opened (`BrowserViewStorageScope.Agent`, a store of their own) and on tabs the user shared (`setSharedWithAgent`, `BrowserViewSharingState.Shared`). The browser editor has Add Screenshot to Chat and Add Area Screenshot to Chat (`features/browserEditorChatFeatures.ts`).

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| The setting | `workbench.browser.enableChatTools`, on by default | **differs**: `kingu.browser.agentTools`, off by default (`agentBrowser.ts` `AGENT_BROWSER_SETTING`). Only a chat run started while it is on gets a session token | P1 |
| Open, navigate, read, click, type, screenshot | `openBrowserTool.ts`, `navigateBrowserTool.ts`, `readBrowserTool.ts`, `clickBrowserTool.ts`, `typeBrowserTool.ts`, `screenshotBrowserTool.ts` | 🆕 `open_browser_page`, `navigate_page`, `read_page`, `click_element`, `type_in_page`, `screenshot_page` (`apps/agent-host/src/browser.ts`), run by the page's own webview (`src-tauri/src/floating_browser/agent.rs`, no Playwright). `read_page` returns the page as text with element references. (2026-11-24) Every chat runtime: Claude on Kingu's in-process MCP server `kingu`; Arkai as its own tools (`arkai/session.ts`; a screenshot as its saved path only); Codex and ACP agents on Kingu's MCP server on loopback (`browserMcp.ts`), with a per-run secret sent in the run's MCP config over the agent's stdio, never in env or argv (an ACP agent without HTTP MCP servers gets none) | P1 |
| Ask before opening and before navigating to an address; Allow once / in this Session / in this Workspace / Always | `confirmationMessages`, `languageModelToolsConfirmationService.ts` | 🆕 `browser.ts` `browserConfirmation`, on the chat's permission card (Claude's `session`, `localSettings`, `userSettings` scopes). Back, forward and reload do not ask. (2026-11-24) Arkai, Codex and ACP: Kingu asks before the call runs (`runtimes/session.ts` `browserGate`), with the same words; an "always" answer lasts for the run. **Differs:** VS Code keeps a workspace or user answer across sessions | P1 |
| **Kingu-only (Orca's reads):** wait, console, network, cookies | – (Orca `agent-browser-bridge.ts`) | 🆕 `wait_for_page`, `read_console`, `read_network`, `read_cookies` (2026-11-24): unasked, like VS Code's reads; console and requests recorded by the page's own world (no CDP); cookies only from a page an agent opened, never a tab the user shared; no JavaScript of the agent's in a wait (Orca's `--fn`) | P2 |
| Agent pages in a store of their own; Share with Agent on a user tab (asked, cookies named) | `BrowserViewStorageScope.Agent`, `setSharedWithAgent` | 🆕 `agent.rs` `Registry::access`; Share with Agent / Stop Sharing with Agent on the tab toolbar (`BrowserSurface.svelte`, `agentBrowser.svelte.ts` `share`) | P1 |
| The shared tab shows while an agent drives it, with a way to stop | the shared-page border and "Sharing with Agent" toggle | 🆕 the tab's indicator (driving, shared, opened by an agent, stopped) with Stop; a dashed border while it drives | P1 |
| Add Screenshot to Chat | `addScreenshotToChat` | 🆕 the toolbar's image button attaches the visible page to the side bar's chat (`floating_browser_capture`, a WKWebView snapshot; macOS only). Add Context also has a Browser Screenshot row (one tab: no question; several: pick one) | P1 |
| **Kingu-only:** the action log | – | 🆕 Log on the indicator: each step with its time and chat, kept in memory until quit; Replay re-runs the navigations, clicks and typing on the tab (reads and screenshots skipped, password typing never kept); Copy log as JSON | P2 |
| Hover, drag, dialogs, list pages, Playwright code | `hoverElementTool.ts`, `dragElementTool.ts`, `handleDialogBrowserTool.ts`, `listBrowserPagesTool.ts`, `runPlaywrightCodeTool.ts` | ❌ not built | P2 |
| Add Area Screenshot to Chat | `addAreaScreenshotToChat` | ❌ not built (Design Mode's element screenshot covers one element) | P2 |

Skipped, and why:

- **On by default.** A page can carry hidden prompts and a shared tab carries the user's logins, so Kingu keeps the tools off until the user turns them on.
- **Terminal agents.** The `kingu` command has no browser method (a test in `floating_browser.rs` fails if one appears), so only a chat run with a token can drive a page. (2026-11-24) Codex, ACP agents and Arkai chat runs now get the tools; a run on an SSH host is not covered here.

Tests: `src/lib/workbench/agentBrowser.test.ts`, `apps/agent-host/test/browser.test.ts`, `apps/agent-host/test/browser-runtimes.test.ts` (2026-11-24: the loopback MCP server, Codex and ACP runs as child processes, Arkai), the Rust tests in `floating_browser/agent.rs`, and e2e `e2e/agent-browser.spec.ts` (Share with Agent asked and cancelled, the indicator, Log and Replay with Orca's reads left out, Stop, the setting off, Add Screenshot to Chat, Add Context › Browser Screenshot with and without a tab, a Codex/ACP run's Open Browser Page? card).

## 21. Sandbox retry, Assisted permissions and the MCP server allowlist (VS Code 1.145–1.147) (2026-11-24)

What VS Code does (`/Users/bright/src-ref/vscode` at `2219f59c`):

- **Retry with updated sandbox permissions (1.147).** When the sandbox stops a command, the Copilot runtime reports the blocked path and the access it needs (`src/vs/platform/agentHost/common/sandboxPathGrant.ts` `ISandboxPathGrant`). The agent host asks "Allow sandbox path access and retry?" with Allow for This Session / Allow for This Workspace / Allow for This User / Skip (`node/copilot/copilotToolDisplay.ts` `getSandboxPathGrantConfirmation`), grants it on the live policy and runs the command again (`copilotSessionSandbox.ts` `grantPathForPendingRequest`). For "This User" the client first writes `chat.agent.sandbox.fileSystem.userConfiguredPaths` (`applySandboxPathGrant`, `sandboxPathGrantSaved`). For the network the Local harness asks "Retry `{0}` command in the sandbox by allowing network access to {1}?" (`terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts` `_getAutomaticSandboxRetryTitle`).
- **Assisted permissions.** `chat.permissions.assisted.instructions` (string, default `''`, `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts`, forwarded to the host as `assistedApprovalInstructions`, `agentHostSchema.ts`) is guidance for the reviewer only, never sent to the agent. A request to run outside the sandbox is never reviewed: "Assisted permissions doesn't review requests to run outside the sandbox."
- **MCP server access and lists.** `chat.mcp.access` (`none` / `registry` / `all`, default `all`), `chat.mcp.allowedServers` and `chat.mcp.deniedServers` (`array | null`, default `null`; entries `{serverName}`, `{serverUrl}` with `*`, or `{serverCommand}`; `src/vs/platform/mcp/common/mcpManagement.ts`, `allowedMcpServers.ts` `checkMcpServerAllowed`). Deny always wins; an unset allowlist allows everything and an empty one nothing; a name entry counts only when the list has no entry of the server's own transport. The managed tier (`src/vs/platform/policy/common/copilotManagedSettings.ts`: `allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`) wins over the user's values, and since 1.145 a managed allowlist decides even with `registry` access.

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| A sandboxed command the sandbox stopped offers a retry with what it needed: a path (read, or read/write; a new file's nearest existing folder; a read-only path upgraded) or the domains it tried to reach | `ISandboxPathGrant`, `_getAutomaticSandboxRetryTitle` | 🆕 Arkai's Bash: `apps/agent-host/src/sandbox/retry.ts` `diagnose` (paths from the output next to a sandbox error, checked against the run's policy; hosts the run's proxy refused, or named in the output and command), `applyGrant`; `arkai/session.ts` asks, `arkai/tools.ts` runs it again in the sandbox | P1 |
| VS Code's wording and choices: Allow for This Session, Allow for This User, Skip | `getSandboxPathGrantConfirmation` | 🆕 `retry.ts` `grantPrompt`; the card in `src/lib/agent/PermissionCard.svelte`. This Session adds it to the run's sandbox only; This User writes `chat.agent.sandbox.fileSystem.userConfiguredPaths` or `chat.agent.sandbox.network.allowedDomains` first (`src/lib/agent/sandboxGrant.ts`, other entries kept, a replaced read-only entry dropped); Skip tells the model the command stays blocked | P1 |
| Allow for This Workspace | `chat.agent.sandbox.*` in workspace settings | **differs**: left out. Kingu reads the sandbox settings from user settings only, so a repository cannot widen the sandbox of the agent working in it | P1 |
| When the retry is asked | runtime | Asked in every permission mode, Allow all included; Rust never answers it with a `chat.tools.*.autoApprove` rule. The retry comes before the model can ask to run outside the sandbox | P1 |
| **Kingu-only:** "Blocked by" names the rule that stopped each path or host (a `deniedPaths` entry such as `~/.ssh`, a host missing from `allowedDomains`, a `deniedDomains` entry, a local address); when one of the user's own deny rules is the cause, no retry is offered | – | 🆕 `retry.ts` `diagnose` (`blocked`), `blockedLine`; the card's list | P2 |
| `chat.permissions.assisted.instructions`, read by the reviewer only, after its default guidance (the first 4,000 characters) | `AssistedPermissionsInstructions` | 🆕 `settings/vscode/chat.ts`; Rust `agent/mod.rs` `ASSISTED_INSTRUCTIONS` (user settings) → agent-host `assisted.ts` `judgePrompt` | P1 |
| A request to run outside the sandbox is never reviewed, with VS Code's notice | `sandbox-bypass` exclusion | 🆕 `assisted.ts` `SANDBOX_BYPASS_NOTICE` | P1 |
| `chat.mcp.access`, `chat.mcp.allowedServers`, `chat.mcp.deniedServers` with VS Code's matching (URL wildcards, exact commands, name entries only without entries of the server's transport) | `checkMcpServerAllowed` | 🆕 `settings/vscode/chat.ts`; Rust `src-tauri/src/agent/mcp_policy.rs` (user settings only). A blocked server does not start, from any source (`agent/mod.rs`); a blocked project server moves to Claude Code's `disabledMcpjsonServers` | P1 |
| The managed tier: `allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`; a managed allowlist decides (1.145) | `copilotManagedSettings.ts` | 🆕 **differs** in where it comes from: Kingu has no enterprise server, so an administrator writes `managed-settings.json` (`/Library/Application Support/Kingu/` on macOS, `/etc/kingu/` on Linux, `C:\ProgramData\Kingu\` on Windows; `mcp_policy.rs` `managed_path`). A managed file that cannot be read blocks every server | P1 |
| `registry` access | the MCP registry VS Code is connected to | **differs**: Kingu has no MCP registry, so `registry` without a managed allowlist allows no server | P2 |
| The servers Claude Code reads itself (`~/.claude.json`) are held to the same lists | – | 🆕 the lists go to Claude Code as its `managedSettings` (`mcp_policy.rs` `for_sdk`) | P1 |
| The MCP Servers view shows a blocked server | the server's state | 🆕 "Blocked by policy" with the list and entry that decided (`src/lib/mcp/mcpModel.ts` `blocked`, `McpPage.svelte`); a blocked server is not passed to runs | P1 |

Skipped, and why:

- **Allow for This Workspace** (see the table).
- **The retry for Claude runs.** Claude uses the Agent SDK's own sandbox, which does not report what it blocked, so only Arkai's Bash gets the retry.
- **The VS Code Settings editor hides the MCP lists** (`included: false`, policy only). Kingu shows them, since a Kingu user has no enterprise policy to set them with.
- **Exactly one key per list entry** is not checked by the settings editor (Kingu's JSON schema has no `required`); Rust drops an entry with none or several, as VS Code's `isValidMatcher` does.

Tests: agent-host `test/sandbox-retry.test.ts` and `test/sandbox.test.ts` (with real `sandbox-exec` runs), `test/assisted.test.ts`; Rust `agent::mcp_policy` tests; desktop `src/lib/agent/sandboxGrant.test.ts`, `src/lib/mcp/mcpModel.test.ts`, `src/lib/settings/vscodeParity.test.ts` (the four settings were added to the parity fixture by hand from `chat.shared.contribution.ts`; the fixture is otherwise from `tools/vscode-settings`); e2e `e2e/sandbox-retry.spec.ts` (the network retry with This User writing `allowedDomains`, the path retry for This Session, Skip).

## 22. VS Code commits `2219f59cf7c..25e7ea7b8ff` (2026-11-24)

Each commit read with `git -C /Users/bright/src-ref/vscode show <sha>`.

| Commit | VS Code | Kingu | Status |
|---|---|---|---|
| `cffbd89fcdf` Keep agent browser pages with their owning session | `sessions/contrib/browserView/browser/sessionBrowserView.ts` (the owner's session, not the focused one; an owner that cannot be resolved gets no page), `browserView/electron-browser/browserViewWorkbenchService.ts` `_openEditorForCreatedView` (the chat widget's window; the check made again after the group is resolved) | 🆕 `src-tauri/src/floating_browser/agent.rs` `home_label` / `window_for`: an agent's page opens in the window of the chat that owns the run (`Session::chat_root`, from `chat:<root>:<id>`), also when the run works in a worktree no window holds; before, it went to the window focused last. A chat whose window is closed gets no page. The window is chosen once, and the same window is asked to show the tab (`cli_server.rs` `ask_label_for`), so moving focus while a page opens cannot split the page and its tab across windows. A run no chat owns (an SSH terminal's claude) keeps going to its folder's window, else the one focused last | ported |
| `95ea6d41d2c` Show slight color when side chat is not focused | `sessions/browser/parts/media/sessionView.css` (unfocused list `opacity: 0.85`; `--session-view-request-background-opacity: 0.4`, 100 ms) | 🆕 `src/lib/agent/chatView.css`, `SideChat.svelte` (`kg-side-chat`): with a side chat (/btw) open, the chat the user is not in fades to 0.85 and keeps its request bubbles at 40% of their fill. **Differs**: VS Code's response-bubble fade has no counterpart (Kingu's responses have no bubble), and high-contrast themes are not left out (Kingu marks no theme type on the page) | ported |
| `06fe31b9170` Preserve slash command argument hints | `agentCustomizationContentExpander.ts`, `agentCustomizationItemProvider.ts` (`readSkillArgumentHint`, `platform/agentHost/common/meta/vscode/skillCustomizationMeta.ts`), `customizationHarnessService.ts` | 🆕 Arkai's MCP skills (`/<server>:<skill>`) now carry the skill's `argument-hint` (`apps/agent-host/src/arkai/mcpSkills.ts` `skillArgumentHint`, `arkai/session.ts`). Command and skill files, prompt files, Claude's and ACP agents' commands and MCP prompts already kept theirs (`agent/slash_commands.rs`, `agent/customizations.rs`, agent-host `normalize.ts`, `runtimes/acp.ts`, `mcpChat.svelte.ts`) | ported |
| `51ec2db5fb2` Keep agent host file suggestions open when typing punctuation | `agentHostInputCompletionsBase.ts` (word separators as trigger characters) | Already equivalent: the `#`/`@` list is worked out from the whole token on every keystroke (`chatContext.ts` `mentionQuery`, `chatContextSources.svelte.ts` `mentionItems`), `-` and `.` included. Test added | already equivalent |
| `b3efde0409c` `editor.suggest.reopenOnDelete`, on in the chat input | `editor/contrib/suggest/browser/suggestModel.ts` `_reopenAfterDelete`, `chatInputPart.ts` | Already equivalent in the chat input: Backspace gives a shorter token and the `#`/`@` and `/` lists open again once something matches; Esc still keeps a list closed for that token (`Composer.svelte`). The editor setting itself is Monaco's, not ported (off by default in VS Code) | already equivalent |
| `b57d5c9e1b2` Don't end a Copilot turn on a failed hook's session error | `copilotAgentSession.ts`, `copilotSdkChatError.ts` `isCopilotSdkHookError` | Already equivalent: a failed Claude hook arrives only as `hook_response` and becomes a `hook_run` for the debug log (agent-host `normalize.ts`, test in `normalize.test.ts`); Codex's `error` notification is only logged and the turn ends on `turn/completed` (`runtimes/codex.ts`); Arkai and ACP runs have no hooks | already equivalent |
| `4ba43feb69a` Remove the unused browser highlight overlay | `platform/browserView/electron-browser/preload-browserView.ts` | Already equivalent: Design Mode's picker outlines with a `position: fixed` box (`floating_browser.rs` `PICK_SCRIPT`), so it never adds to the page's scroll area | already equivalent |
| `3e4df89cb34` Autosave sandbox profiles | `chatAgentTools/browser/sandboxProfilesEditor.ts` | Skipped: Kingu has no sandbox profiles editor (the sandbox is set in user settings, section 21) | skipped |
| `25e7ea7b8ff` Reconnect pinned canvases of a canvas-first session | `copilotAgent.ts`, `pinnedCanvasService.ts` | Skipped: Kingu has no canvases | skipped |
| `0bd5ee94ada` Remove unused mobile gesture helpers | `sessions/browser/parts/mobile/` | Skipped: removal of code Kingu never had | skipped |

Tests: Rust `floating_browser::agent` (`a_page_opens_in_its_chats_window_not_the_focused_one`); agent-host `test/arkai-mcp-skills.test.ts`; desktop `src/lib/agent/chatContext.test.ts`.

## 23. The chat panel's last chat and the agent last picked (2026-11-24)

What VS Code does (`/Users/bright/src-ref/vscode` at `25e7ea7b8ff`):

- **The chat shown.** `ChatViewPane` keeps a workspace memento, `interactive-session-view-<provider>` (`workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts`, `IChatViewPaneState.sessionResource`, `StorageScope.WORKSPACE`). Each model it shows is written there (`this.viewState.sessionResource = model.sessionResource`), and `getTransferredOrPersistedSessionInfo` opens it again. The constructor clears it when `lifecycleService.startupKind !== StartupKind.ReloadedWindow` and `chat.restoreLastPanelSession` is `false` (its default, `chat.shared.contribution.ts`). So a reloaded window always shows the chat it showed, and a fresh start does only with the setting on.
- **The agent of a new chat.** The session target picker records the pick (`sessionTargetPickerActionItem.ts` `_run` → `recordUserSelectedSessionType`, `common/constants.ts`). It is stored in profile storage (`chatSessionTypePreference.ts`), and picking the computed default clears it. `getDefaultNewChatSessionTypeAndReasonFromServices` starts a new chat on the remembered type while it is usable (`rememberedSelection`), else on the computed default.

| Feature | VS Code | Kingu | Priority |
|---|---|---|---|
| The panel remembers the chat it shows, per folder (a new chat too) | `viewState.sessionResource` (workspace memento) | 🆕 `src/lib/agent/chatViewState.ts` `saveShown` (localStorage `kingu.chat.panelSession`, folder → chat id, `''` for a new chat; the 100 most recent folders), written from `AgentPanel.svelte` | P1 |
| A reloaded window shows that chat again; a fresh start does only with `chat.restoreLastPanelSession` on; a chat that is gone gives a new chat | `startupKind !== ReloadedWindow` clears the memento | 🆕 `chatViewState.ts` `restoredChat`, `takeReload`. A reload is detected with a sessionStorage marker (`kingu.window.loaded`), which survives `location.reload()` (Reload Window) but not a restart. Only the first folder opened after the reload restores this way. Before, the setting showed the most recent chat, not the one shown | P1 |
| A new chat starts on the agent last picked in the session target picker, after a restart too, while that agent is listed; picking the default forgets it | `recordUserSelectedSessionType`, `getRememberedSessionType` | 🆕 `chatViewState.ts` `saveRuntime`, `newChatRuntime` (localStorage `kingu.chat.lastRuntime`; the default is `kingu.agent.runtime`). A new chat already on screen when the agents get listed switches to the remembered one. New Chat's "New Chat with …" menu items do not record a pick, as in VS Code | P1 |

Tests: `src/lib/agent/chatViewState.test.ts`; e2e `e2e/chat.spec.ts` (reload versus restart, the setting on, the remembered agent and its reset).
