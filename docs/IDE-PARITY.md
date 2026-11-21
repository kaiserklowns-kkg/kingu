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
