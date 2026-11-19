# ADE parity: Orca → Kingu, feature by feature

Orca reference: `/Users/bright/src-ref/orca` at 9103a362 (user docs `docs/site/content/docs/`,
renderer `src/renderer/src`, main `src/main`). Kingu paths are under `apps/desktop/`.
Every row was checked against Kingu's code, not just the name of a file or IPC namespace.

**Priority:** P0 breaks the daily flow (create worktree → run agent → see status → review diff →
PR). P1 is a gap you notice. P2 is nice to have. "–" means at parity.

**Status:** present, partial or missing. A row tagged **(this round)** changed in this pass.

Out of scope here: SSH/remote projects and IDE features (explorer, search, editor, debugger, tasks).

## 1. Sidebar and worktree list

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| Group by project | Project rows with their worktrees nested (`model/worktrees.mdx` "Sidebar layout") | present (`ade/AdeSidebar.svelte`, `sidebarModel.ts`) | – |
| Filter menu | Hide sleeping (except default branch), default branch, automation, CLI-created, detached; count; Clear | **present (this round)**: every switch, including "Hide CLI-created": `kingu task create` marks the task `origin: 'cli'`, and `kingu.sidebar.hideCliCreatedTasks` hides it (`sidebarModel.Filters`, `sidebarView.hiddenBy`). Older CLI-created tasks have no marker, like Orca's legacy rows | – |
| Unread in bold | Unread worktrees bold, no badge | present (`AdeSidebar.svelte` `isUnread`) | – |
| Pin | One Pinned section above every group, in the list's sort order; pinned rows leave their own group unless showPinnedWorktreesInGroups (`src/shared/sidebar-list/sidebar-row-plan.ts` planSidebarRows, `src/shared/worktree-occurrence-plan.ts`, `src/shared/sidebar-list/row-types.ts`, `src/shared/sidebar-list/pinned-section-worktrees.ts`) | **present (this round)**: the Pinned group follows the current sort and carries nested cards with their parent; pinned cards leave their own group unless `kingu.sidebar.showPinnedInGroups` (`sidebarView.pinnedPlacement`) | – |
| Inline rename | Double-click the title renames it; elsewhere on the card opens Edit Details | **present (this round)**: double-click on the title renames, elsewhere on the card opens Edit Details (`AdeSidebar.svelte`) | – |
| Edit Worktree Details | Name, linked GitHub/Linear issue (URL auto-detect), comment | **present**: `EditDetailsDialog.svelte`; the comment can also be set by an agent with `kingu task set [<slug>] --comment <text>` (round 3; no slug = the worktree it runs in, like `orca worktree set --comment`) | – |
| Multi-select and bulk actions | Cmd-click / Shift-click; context menu acts on the whole selection (`sidebar/worktree-list/navigation/use-selection.ts`) | **present (this round)**: ⌘-click toggles, Shift-click selects a range (`sidebarSelection.ts`); right-click on a selected card offers Sleep / Pin / Mark Read / Mark Unread / Delete for all of them (one confirmation). Not yet: the "Review N Branches" step after a bulk delete | – |
| Context menu | Archive / Sleep / Delete; with children: "With Descendants (N)", "Delete with Descendants…" | **present (round 3)**: Archive (`archived_at`, off the side bar, worktree kept; an "Archived (N)" row reopens or unarchives), "Sleep with Descendants (N)", "Delete with Descendants (N)…" (children first, one confirmation; `lineage.ts`) | – |
| ⇧⌘⌫ delete | Deletes the **selected** worktree(s) (not hovered: `sidebar-workspace-delete.ts`), only with focus on the worktree list; never the main worktree; key repeat ignored; with confirmation | **present (this round)**: `kingu.agents.deleteWorkspace` acts on the selected card or the multi-selection (bulk confirm) with focus in the worktree list, skips the primary checkout, ignores key repeat and open menus/dialogs (`deleteShortcut.ts`). The key no longer fires from a terminal or editor; the palette still runs it | P2 |
| Child chip | "N children" chip; Toggle Child Workspaces shortcut | present (`childAgentToggle`) behind `kingu.sidebar.showChildAgents`; no shortcut | P2 |
| Reorder projects by drag | Drag repo rows | present (`dragProject`, `projects.move`) | – |
| Jump palette (⌘J) | Recents, needs-you first; PR `#123`; "Create worktree" row; Tab for host/project filter (`components/worktree-jump`, `model/quick-open.mdx`) | **present (this round)**: ⌘J in the Agents layout (⇧⌘J everywhere) opens `jumpItems` (`worktreeActions.ts`): with nothing typed, needs-you then the 9 most recently used, then the folder; typing matches title, then branch, and `#N` / `N` finds a PR; the last row creates a worktree (the composer opens with the text). No host/project Tab filter (one folder per window) | – |
| Numeric shortcuts ⌘1–9 | Jump to visible sidebar row N (`workspace-shortcut-ipc-bridge.ts`) | **present (this round)**: `kingu.agents.selectWorktree1..9`, scoped to the Agents layout, follow the sidebar's visible order (`sidebarOrder`); the IDE keeps ⌘1–3 for editor groups | – |
| Non-Orca worktrees card | Hidden-count card → dialog with per-worktree Show, per-project overrides | present (2026-11-19): read-only cards for the shown ones; a "N hidden worktrees" card opens a dialog to search and Show one, kept per project (`kingu.worktree.shownExternal`, `splitExternal`); Hide in a shown card's menu undoes it. Per-project overrides of the kinds go through the repo scope of the visibility settings. Not yet: Orca's GSD source | P2 |
| Preserved branches review | After a bulk delete, "Review N Branches" lets you force-delete kept branches | **present (round 3)**: `adeTasks.removeMany` collects the branches git kept; a notice opens `BranchReviewDialog.svelte`, where the checked branches are force-deleted (`git_delete_branch`) and the rest kept | – |
| Activity list in the sidebar | Chronological feed (`activity.mdx`) | present (checked 2026-11-19; the row was out of date): the Now page's feed lists notices (finished, needs you, failed, with the response preview) and created worktrees newest first, with a filter (⌘F) and a click to the task (`agentInbox.ts` `activityFeed`, `NowPage.svelte`). Not yet: threads grouped by status | P2 |

## 2. New-worktree flow

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| Background creation | Dialog closes at once; a progress row in the sidebar; Retry on failure; Cancel; 25 name-conflict retries (`model/worktrees.mdx`, `shared/new-workspace/worktree-create-retry-policy.ts`) | **present**: background with steps, Cancel, Retry (round 2); on "already exists" it tries `name-2`, `name-3`… up to 25 attempts (round 3, `createRetry.ts`) | – |
| Agent selector at create, Set as default | `NewWorkspaceComposerAgentSection.tsx`, including Blank Terminal | **present (this round)**: `AgentPick.svelte` in the composer (`AgentsLayout.svelte`) and the New Task form. It lists CLIs on PATH minus disabled ones; the same CLI keeps the flags of `kingu.agent.cli` (`agentForPick`, `agentCli.ts`); "Set as default" writes `kingu.agent.cli`. No Blank Terminal | – |
| Start-from picker | Base ref from a searchable list of local and remote branches (`ComposerBaseRefPicker.tsx` → `CreateFromPicker.tsx`); the picker takes no typed SHA. A full SHA is only accepted by the main process (`commit-object-ref.ts`) | **present**: branch select, plus existing branch / PR on the New Task form. Like Orca there is no SHA field; Rust `create_named_sparse` and `kingu task create --base` already take any commit (`rev-parse --verify <base>^{commit}`). Checked against Orca 9103a362 | P1 |
| Branch name override | Advanced → Branch name | **present (this round)**: Advanced → Branch name on a plain new task; used as the whole branch name (prefix setting not added), `-2`… on conflict, never AI-renamed (`taskNaming.ts`). Last path part limited to letters, digits, `-`, `_`; a taken name is suffixed, not reused | P2 |
| Parent workspace | Advanced → Parent workspace: nests in the sidebar only, no git change; archived ones and cycles excluded (`model/worktrees.mdx`, `ComposerParentWorktreePicker.tsx`) | present (2026-11-19): Advanced → Parent task in the New Task form lists the folder's tasks that are not archived; the new task nests under it and starts from the base as usual. "New Task from This Task" still stacks (forks the parent's branch). The folder composer has the same choice as a chip beside the base branch | P2 |
| Link issue at create | Paste a GitHub/Linear/Jira/GitLab URL in the name field | **present (this round)**: an issue URL as the whole name is looked up 200ms after typing stops and offered as a link; Enter or a click takes it (name becomes the issue title, a pill shows the reference, the prompt defaults to the issue), and Enter never creates a task named after the URL (`issueUrl.ts`, `issueUrlLookup.ts`, `NewTaskForm.svelte`). Differences: only a plain new task carries the link (not best-of-N or stacked); a GitHub link is stored as `owner/repo#n` even for the open folder's repo, so `kingu.issues.command` does not run for it; one Jira site and one GitLab host (the connected ones); no "Switch project?" prompt for another repo's issue Also in the folder composer's name field since 2026-11-19 (`TaskNameField.svelte`); there a taken link fills an empty prompt from the issue. | P1 |
| Default name | Marine creature when empty (`shared/marine-creatures.ts`) | **present (this round)**: empty name → prompt's first line, else an unused marine creature (Orca's 552 names, `name-2` tiers); the creature is never sent as the prompt. No retired-name registry; plain new tasks only The folder composer also names a task whose prompt has nothing a branch keeps after a creature (2026-11-19). | P2 |
| Emoji shortcodes | `:rocket:` picker; branch uses the shortcode (`src/shared/emoji-shortcode-catalog.ts`, `workspace-emoji-shortcodes.ts`) | present (this round) in the New Task name: a closed `:code:` becomes the emoji, `:query` lists up to 8 matches (↑↓, Enter/Tab, Escape), and task / attempt slugs spell known emoji as their shortcode (`emojiShortcodes.ts`, same `emojibase-data` 17.0.0). The folder composer has the same name field, and (2026-11-19) a 😀 picker button lists Orca's 48 defaults or a search and inserts at the selection (`pickerEmojis`, `insertEmoji`). Rename in the side bar turns a closed `:code:` into its emoji, and the jump palette (⌘J) matches an emoji-named task by its shortcode (2026-11-19). Not yet: the suggestion list while renaming | P2 |
| Shared directories / symlink paths | `orca.yaml worktree.sharedDirectories` + Shared Paths (APFS clone or symlink) | present (`agent/scripts.rs` `link_paths`) | – |
| `.worktreeinclude` | Copies listed gitignored literal paths; budget 2 GiB / 50,000 entries; ≤1000 entries; file ≤256 KB (`git/worktrees/content-paths/worktree-include-file.ts`, `ipc/worktree-include-copy-budget.ts`) | **present (this round)**: `scripts.rs` `parse_worktree_include`, `worktree_include_paths` (`git check-ignore`), `copy_includes` (clonefile, then copy). Runs in `worktree_link_shared` | – |
| Setup / archive scripts, trust, default tabs, issue command | `orca.yaml` | present as `kingu.yaml` (`agent/kingu_yaml.rs`, `scripts.rs`) | – |

## 3. Agent launch and status

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| Launch with default agent, per-agent args, autonomy flags | `model/agents-sessions.mdx` | present (`agentCli.ts`, `agentProfiles.ts`, `tasks.svelte.ts` `#launchCli`) | – |
| Per-account env (Codex home etc.) | hot swap | present (`accounts/store.rs`) | – |
| Claude hook events | SessionStart … plus StopFailure, PostToolUseFailure, PostCompact, Elicitation(Result), SubagentStart/Stop, TeammateIdle, PostToolBatch, each gated by Claude version (`main/claude/hooks/claude-managed-hook-events.ts`, `cli-capabilities/claude-hook-event-versions.ts`) | **present (this round)**: `hooks.rs` probes `claude --version` once and adds SubagentStart/Stop (2.0.43), PostToolUseFailure (2.0.56), Elicitation/ElicitationResult (2.1.63), PostCompact (2.1.76), StopFailure (2.1.78); mapped in `agentHooks.ts`. Not yet: TeammateIdle, PostToolBatch | P2 |
| Subagent roster | A child still working keeps the lead "working" after its Stop | **present (this round)**: `HookState.subagents` and `leadDone` (`agentHooks.ts`). The lead's Stop with subagents running shows "N subagents still running"; the last SubagentStop ends the turn. Not yet: nested subagent rows | – |
| Hooks for a Claude typed by hand in another pane | Orca's hooks sit in the user's Claude settings | **present (this round)**: `status_hooks.rs` `Agent::Claude` writes Kingu's entries into `$CLAUDE_CONFIG_DIR` or `~/.claude/settings.json`, only for claude ≥ 2.0.45 (`CLAUDE_GLOBAL_FLOOR`). They are inert outside Kingu's task panes, and removed when `kingu.agent.statusHooks` is turned off. `applyHook` maps the tagged lines with the claude mapper | – |
| Other CLIs' hooks (gemini, cursor, copilot, droid, codex, opencode) | per-provider mappers | present (`status_hooks.rs`, `agentHooks.ts`) | – |
| Needs-input detection | permission, question, elicitation | present (`agentHooks.ts` `needsInput`, `CliQuestion.svelte`) | – |
| Approve/deny a permission from the UI | Native chat; a blocking PermissionRequest hook (~126 s) | partial: the task's quick-reply card (task page, over the agent terminal) shows Allow once / Deny while its CLI's hooks report a permission prompt, and the phone does the same (`CliQuestion.svelte`, `cliSessions.answerPermission`, 2026-11-19). Both press Enter (the highlighted choice) or Esc in the CLI; no blocking hook answer yet | P2 |
| State dots | spinner / amber ? / green / red / gray (`AgentStateDot.tsx`) | present; the waiting "?" is violet, not amber (`AdeSidebar.svelte` `statusDot`) | P2 |
| Progress ring (OSC 7501) | `shared/program-status/protocol.ts` | partial (this round): terminal tabs draw a progress ring / working / blocked / done / error from OSC 7501 root reports (`ade/programStatus.ts`, `paneProgram.svelte.ts`, `ProgressRing.svelte`); no `?` query reply (answering makes Claude drop the title glyphs Kingu reads), no sub-id (subagent) rows, not on sidebar cards or the main agent tab. Seen in the running app (2026-11-18): a ring for the percentage, a green dot when done | P2 |
| Notifications | done / needs input / failed; suppressed when focused; sound; click jumps | present (`agentNotify.ts`, `notify.rs`); sound is a system name only; click opens the task, not the pane | P2 |
| Dock badge, unread | | present (`adeAttention.svelte.ts`) | – |
| Notification inbox | Header bell lists unread notifications; right-click mark unread | **present (round 3)**: a "Notifications" bell in the sidebar (`InboxBell.svelte`, `agentInbox.ts`). It records every agent notice, even ones not sent to the OS, keeps the newest 100 in localStorage, toggles read/unread, and opening a task reads its notices | – |
| Activity feed | Timeline with previews, running pinned, ⌘F | **present (round 3)**: the Now page keeps running and needs-you tasks on top and adds an Activity history (notices with previews plus created worktrees, newest first, ⌘F filter; `activityFeed`) | – |
| Dashboard | Kanban per agent, pop-out (`model/agents-sessions.mdx` › Agent dashboard) | partial: the Tasks board has Orca's agent columns (Needs you / Working / Done, `kingu.board.view` = agent) beside the workflow columns, and (2026-11-19) a search over title, worktree, branch and agent with a shown count and ⌘F (`boardSearch.ts`), and a PR status filter (Open, Draft, Merged, Closed, No PR). and Orca's Idle column (finished tasks you have seen; hidden unless Show idle, `kingu.board.showIdle`). Not yet: project filter (the board is per folder), pop-out | P2 |
| Hibernation | Off by default; per pane; auto-resume on return | **present (this round)**: returning to a task whose CLI was hibernated this run resumes its session once, no click (`hibernation.ts` `autoResumeOnReturn`, `attempts.svelte.ts`). One CLI per task, not per pane; after an app restart it still needs a click (Orca resumes on reveal). Not tried with a real agent yet | P2 |
| Session history | ~18 CLIs, scopes, resume, copy command | **partial (round 3)**: Claude, Codex (`$CODEX_HOME/sessions` rollouts) and Gemini (`~/.gemini/tmp/<sha256(path)>/chats`) in the Agents panel, each with its own resume command (`sessions.rs`, `agent_cli_sessions`). Not yet: OpenCode (SQLite) and the other CLIs | P2 |
| Session restore | PTY daemon | present (`pty.rs` `kingu-ptyd`) | – |
| Usage tracking | status-bar usage | present (`usage/`, `UsageStatus.svelte`) | – |

## 4. Task page, diff review, comments

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| Diff against start-from ref (staged + unstaged + untracked) | `review/diff-viewer.mdx` | present (`TaskPage.svelte`, `agent/review.rs`) | – |
| Side-by-side / inline, next/prev change | | present (`workbench/DiffHost.svelte`) | – |
| Line notes on diffs | gutter "+", ranges, ⌘↩ (`components/diff-comments`) | present (`diffNoteZones.ts`, `diffNotes.ts`, `agent/notes.rs`) | – |
| Notes prompt format | `shared/diff-comments-format.ts` | present, verbatim (`diffNotes.ts` `formatNote`) | – |
| Send notes to… which agent | Menu of the worktree's live agents + new agent; send / add-to-chat (`ReviewNotesSendMenuContent.tsx`) | **present (this round)**: `agentTarget.svelte.ts` / `agentTargets.ts` offer the task agent, its composer without sending, agents in its other panes, a new task, or copy; with only the task agent it sends straight there. Used by review notes and the recovery prompts | – |
| Attribution (AI vs human lines) | `review/attribution.mdx` only: checked 2026-11-19, Orca's source at 9103a362 has no line-provenance store or diff gutter marker (no `attribution` / `provenance` code for diffs) | not built: nothing in Orca's source to match; revisit when it ships | — |

## 5. Commit, push, PR, checks

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| AI commit message | | present (`AdeSourceControl.svelte` `generate`, `aiText.ts`) | – |
| Primary button Stage → Commit → Push/Pull/Sync | `review/commit-push.mdx` | present (`AdeSourceControl.svelte`) | – |
| Amend | Not in Orca's source (no amend action at 9103a362; rewritten history is only pushed by an explicit Force Push with lease) | Kingu extra (this round): Commit (Amend) in the ADE commit menu; confirms when a remote branch has the commit, then offers force push with lease (`amend.ts`, `git_amend_info`). While the upstream still has the old copy (same branch/upstream, same commits behind) the primary button is Force Push instead of Sync, and Pull / Sync / Commit & Sync in the menu warn before merging it back (`stillAmended`); tried in the running app 2026-11-19 | P2 |
| Commit/push failure "Fix with AI" | `shared/source-control/recovery/source-control-commit-failure.ts` | **present (this round)**: `recoveryPrompts.ts`, ported verbatim (summaries, 12,000-character output cap, at most 40 files for a push, `isPushHookFailure`). "Fix with AI" and "Copy output" appear under a failed commit or a push-hook failure (`AdeSourceControl.svelte`) | – |
| Conflicts: Resolve with AI | `source-control-conflict-prompts.ts` | **present (this round)**: Orca's prompt, with conflict kinds and the paused-operation variant (`resolveConflictsPrompt`). Now also available in the folder itself, through the agent picker. Not yet: the PR-mergeability conflict prompt | – |
| Create PR (base, title, body, draft, stacked) | | present (`PrCreateDialog.svelte`, `forge_pr_create`, `review.rs`) | – |
| AI PR draft | JSON `{base,title,body,draft}`; `## Problem`/`## Solution`; `Fixes`/`Refs #N` (`pull-request-generation.ts`) | **present**: Orca's prompt (round 2), now with the linked issue's description fetched from GitHub/Linear/Jira/GitLab (round 3, `issueDescription`) | – |
| PR status on the card | | present (`prStatus.svelte.ts`, `AdeSidebar.svelte`) | – |
| Checks, logs, fix with agent | | present (`AdeChecks.svelte`, `PrChecks.svelte`, `pr.rs`, `buildFixChecksPrompt`) | – |
| Review comments: send / reply / resolve / react | | present (`PrComments.svelte`, `prComments.ts`) | – |
| Merge (methods, auto-merge, ready) | | present (`PrMerge.svelte`, `pr.rs`, `forge.rs`); no merge-queue wording | P2 |
| GitHub issues → workspace, GitHub Projects, Linear, Jira, GitLab MRs | | present (`IssuesPage.svelte`, `taskSources.svelte.ts`, `linear.rs`, `jira.rs`, `gitlab.rs`, `agent/mr.rs`) | – |
| In-app issue detail editing | drawer with status / assignee / comments (`components/github-item-dialog`, `linear-item-drawer-*`, `jira-issue-*`) | partial (2026-11-19): the folder's GitHub issues open in a drawer on the Issues page with the body and latest comments, Close / Reopen, labels and assignees to add or remove (Assign me), and a comment box (`IssueDrawer.svelte`; Rust `gh_issue_set_state`, `gh_issue_edit`). Title and description edit in place (not a description cut short when read). Linear, Jira and GitLab issues open in a read-and-comment drawer with Open in the browser for changes (`TrackerIssueDrawer.svelte`, `trackerDetail.ts`). Not yet: milestones, changing state or fields of Linear / Jira / GitLab issues in place | P2 |

## 6. Terminal and browser panes, tabs and splits

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| Per-worktree layout kept | whole pane tree per worktree | **present (this round)**: browser tabs (with their latest URL), file and diff tabs, tab order, pins, colours and splits are saved per folder (`kingu.adeTabs`, `parseSavedTabs` in `adeSplit.ts`). Untitled buffers and preview tabs start over | – |
| Drag a tab to an edge to split (any tab kind) | `model/tabs-panes-splits.mdx` | **present (round 3)**: regions form a tree (`adeSplit.ts` on the terminal pane tree). Drop any tab (agent, terminal, browser, file, diff) on the right/bottom 30% of any region; regions nest without limit; each region has a resize divider and a close button; a click in a region makes its tab active; picking a tab in the strip shows it in the active region; saved per folder. Not yet: a tab strip per region | P2 |
| Terminal splits, find, scrollback restore, bell, rename, copy-on-select, OSC 52 | `terminal.mdx` | present (`terminal/paneLayout.ts`, `TerminalFind.svelte`, `pty.rs`) | – |
| Terminal links → in-app browser, link popover | | **present (this round)**: a followed web link in an Agents-layout terminal opens (or reuses) a browser tab of that worktree; adding Shift sends it to the system browser (`kingu.browser.openLinksInApp`, `Terminal.svelte` `onopenurl`). No popover | – |
| Agent state on every agent terminal tab | `terminal-tab-activity-status.ts`, `TerminalTabLeadingIcon.tsx`, `AgentStateDot.tsx` | **present (this round)**: a terminal tab running an agent shows that agent's own state and icon (`paneAgents.tabRow`, `CardStatusDot.svelte`, `AdeTabBar.svelte`); a split tab shows its most urgent pane. Differences: states are working / needs you / idle only (no failed, interrupted or done-check per pane); the root folder's terminals show none; the main agent tab still shows the task-wide state | P1 |
| Browser: address bar, tabs per worktree | `browser/overview.mdx` | present (`BrowserSurface.svelte`, `floating_browser.rs`); restored after a restart (this round) | – |
| Browser: DevTools, find, hard reload, zoom, downloads, history | | **present (rounds 2–3)**: zoom, find, DevTools, downloads to ~/Downloads (no overwrite, notice with Show in Finder; `on_download`), history (300 pages, toolbar button). Not yet: hard reload | – |
| Design Mode (pick element → agent) | `browser/design-mode.mdx` | **present (round 3)**: crosshair button injects a picker (outline on hover, Esc stops). A click sends the selector, trimmed HTML (3000 chars), key computed styles, box and text back through a navigation to Kingu's own scheme, which `on_navigation` takes and cancels. The element goes into the task agent's composer without sending (`pickedPrompt`, `draftPrompt`). Not yet: screenshot, source location | – |
| Browser profiles / cookie import | `browser/profiles.mdx` | **partial (round 3)**: `kingu.browser.profile` gives new tabs a WebKit data store per profile name (macOS 14+). Not yet: a per-tab picker, cookie import | P2 |
| Quick Commands button | tab bar split button (`tab-bar/TabBarQuickCommandsMenu.tsx`, `terminal.mdx`) | present (2026-11-19): the main part runs the command used last (else the first) in a new terminal tab, typed as is; the chevron opens a searchable list (label and command text, the last used first) with Add Command…. Commands are Global (Settings › Terminal) or Project (the project's page, kept in Kingu's per-project store, never the repository's file) and join. Add Command… opens a dialog (Label, Command, Scope Global / This project; `QuickCommandDialog.svelte`, `withQuickCommand`). Each row of the list has Edit (the same dialog; a new label or scope moves the entry) and Delete (asks first). Not yet: agent prompts, Append Enter off, the shortcut | P2 |

## 7. Settings, shortcuts, onboarding

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| Settings sections (General, Agents, Git/Repository, Notifications, Appearance) | `settings.mdx` | present (`settings/orcaPane.ts`, `settings/ade/*`; Kingu's own gap list in `settings/ade/orcaMap.ts`) | – |
| Settings → Browser | link routing, search engine, zoom (`settings.mdx` › Browser, `shared/browser-url.ts`, `browser-page-zoom.ts`) | present (2026-11-19): a Browser page under Workflows with Open Links In App, Profile, Search Engine (Google, DuckDuckGo, Bing, Kagi; the address bar searches with it) and Default Zoom (new tabs start at it, ⌘0 returns to it). Not yet: remote / SSH routing, the terminal link popover toggle. Design Mode and DevTools defaults are in Orca's settings doc only, with no setting in its source (checked 2026-11-19) | P2 |
| Shortcuts editor | | present (`settings/pages/ShortcutsPage.svelte`) | – |
| Default chords | `shared/keybindings/definitions-core-*.ts` | partial. Same chords for tabs, panes, sidebars, rename, floating. Different: switch worktree (Orca ⌘K, Kingu ⇧⌘J), Chat/terminal toggle, ⇧⌘A. Missing: ⌘N new worktree, ⌘1–9 worktrees, ⌥⌘←/→ history, ⇧⌘I ports, browser chords | P1 |
| Onboarding | theme, agent, notifications, integrations; landing preflight | partial: preflight present (`doctor.rs`, `SetupBanner`); the welcome tour has no agent, theme or notification step (`Welcome.svelte`) | P2 |

## 8. Mobile

| Feature | Orca behaviour (source) | Kingu status (file) | Priority |
|---|---|---|---|
| Pairing, devices, revoke | `mobile.mdx`, `src/main/ipc/mobile.ts` | present (`mobile.rs`, `MobilePairDialog.svelte`); see MECHANICS.md › Mobile pairing | – |
| Live agent status on the phone | from the agent status store | **present (this round)**: the window pushes its live rows (`mobile.svelte.ts` → `mobile_live`) on change and every 10 s. Rust lays them over tasks.json for 30 s (`LIVE_TTL_MS`). The phone polls every 3 s and shows the live line | – |
| Answer permission prompts / questions from the phone | Chat UI on mobile | **present (this round)**: `POST /api/answer` (allow / deny / question with selections), only while that prompt is live. Allow = Enter, Deny = Esc, a question = Orca's ask keystrokes (`cliSessions.answer`) | – |
| Push notifications, relay, terminals, diffs, git, create workspace on the phone | native app | missing (no phone app) | P2 |

## The claude user-settings hook (`~/.claude/settings.json`)

Kingu writes these hooks the same way Orca does: `src/main/claude/hooks/hook-settings.ts` (`getConfigPath`, `applyManagedHooks`, `removeManagedHooks`) and `hook-script.ts` (the script exits 0 without Orca's pane environment).

- **What it writes.** It appends one group to each of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`, `SubagentStart` and `SubagentStop`. The tool events get matcher `*`. Each group is:

  ```json
  {"hooks":[{"type":"command","timeout":10,"command":"if [ -f '<app data>/agent-status/agent-hook.sh' ]; then /bin/sh '<…>' claude <Event>; else cat >/dev/null 2>&1 || :; fi"}]}
  ```

  The file is `$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json` when that variable is unset.
- **Merge.** Kingu's entries are found by the script path (`agent-status/agent-hook.sh`). They are replaced, and everything else stays: the user's own hooks in the same event, other keys, key order, the file mode, and a symlinked file's target. The previous file is copied to `settings.json.kingu.bak` and the write is atomic. A file that isn't valid JSON is left untouched.
- **When.** It is written only for a claude that reports version 2.0.45 or newer (`CLAUDE_GLOBAL_FLOOR`; an older claude rejects the whole file on an unknown event). Writing again changes nothing (idempotent).
- **Removal.** Turning `kingu.agent.statusHooks` off removes only Kingu's entries, so the file returns to exactly what the user had (an empty `hooks` key Kingu added goes too).
- **Inert outside Kingu.** The script writes only when `KINGU_AGENT_HOOK_FILE` names a file under `agent-hooks/`. Only task panes (`ade:` PTY keys) get that variable. The CLI Kingu launches itself (`cli:` key) does not, so it never reports twice. If the script is missing, the command only drains stdin. The hook prints nothing, so claude's own decisions are unchanged.
- **Tests.** `status_hooks.rs` `claude_user_settings_get_entries_next_to_the_users` and `script_appends_tagged_lines_only_to_a_kingu_hook_file`.

## Biggest remaining gaps

1. **Tab regions:** no tab strip of their own (one strip for the worktree).
2. **Browser:** profiles have no per-tab picker or cookie import; there's no hard reload; Design Mode sends no screenshot or source location.
3. **Session history:** OpenCode (SQLite) and the other CLIs are not read.
4. ~~**Pins:**~~ done: Orca also uses one Pinned section (`sidebar-row-plan.ts`); Kingu now matches its order and single-location placement.
5. **Agent state on tabs:** agent tabs other than the main one show only a bell, not a state dot.
6. **Claude roster:** TeammateIdle and PostToolBatch are not handled.
