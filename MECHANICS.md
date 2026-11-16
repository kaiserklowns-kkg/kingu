# Orca → Kingu: mechanics sheet

Read from Orca 1.4.253 (`/Applications/Orca.app`, Electron; `app.asar` → `out/main/index.js` and
`out/main/workspace-space-scan-worker-entry.js`). Orca is JavaScript, so "source" below names the
IPC channel and the minified function in `out/main/index.js` instead of a native address. Kingu's
code is written from these rules, not copied.

## What the decompiled native code holds

Orca's native programs were opened and decompiled (Deep mode, `core_target_open` +
`native_function_pseudocode`):

| Program | Functions | What it does |
|---|---|---|
| `Contents/MacOS/Orca` (53 KB, arm64) | `entry` 0x100000460, `sub_1000004c0` 0x1000004c0 | Electron's stock launcher. `sub_1000004c0` checks the standard input, output and error handles (0, 1, 2) with `fstat` and reopens any closed one (EBADF = 9) on `/dev/null`. `entry` then calls `ElectronMain` unless the RunAsNode fuse is on *and* `ELECTRON_RUN_AS_NODE` is set to a non-empty value, in which case it calls `ElectronInitializeICUandStartNode`. No strings for workspaces, `du`, `lsof`, ports or worktrees (search returned 0). |
| `Contents/MacOS/orca-process-footprint` (Swift, universal) | `footprint(pid)` 0x100002d10, `main` 0x1000029bc | Memory meter, see below. |

### Launch: closed standard handles (applied to Kingu's start-up)

Read from `sub_1000004c0` (0x1000004c0), called first by `entry` (0x100000460); strings checked
byte by byte at 0x100000625 (`/dev/null`), 0x10000062f (`r`) and 0x100000631 (`w`).

| Rule | Value | Source |
|---|---|---|
| Handles checked, in order | 0 (input), 1 (output), 2 (errors) | 0x1000004c0, `fstat(0…2)` |
| When to reopen | `fstat` fails **and** errno is 9 (EBADF); any other error leaves the handle | 0x1000004c0, `w8 == 9` |
| Reopened on | `/dev/null` | string 0x100000625 |
| Mode for handle 0 | `r` (read-only) | data 0x10000062f |
| Mode for handles 1 and 2 | `w` (write-only) | data 0x100000631 |
| When | before anything else, then the app starts | `entry` 0x100000460 |

Kingu: `startup.rs` › `reopen_closed_stdio` (`EBADF`, `STDIO_REOPEN`), called first in `run()`.
Checked by launching the build with all three handles closed (`<&- >&- 2>&-`): it starts and draws.
Orca's other launcher branch (start as plain Node when the RunAsNode fuse is on and
`ELECTRON_RUN_AS_NODE` is non-empty) has no Tauri counterpart.

So Workspace Space and Workspace Ports are not native code: their rules live in Orca's JavaScript
(`app.asar`), read directly and listed in the next sections. The other two helpers
(`orca-keyboard-layout`, `orca-notification-status`) are unrelated to what was built and weren't
decompiled.

### Process memory: `orca-process-footprint` (applied to Kingu's status bar memory)

| Rule | Value | Source |
|---|---|---|
| Per-process memory | `proc_pid_rusage(pid, RUSAGE_INFO_V0)` → `ri_phys_footprint` | `footprint(pid)` 0x100002d10 |
| Rusage flavor | 0 (`RUSAGE_INFO_V0`) | 0x100002d10, second argument `0` |
| Field offset in the 96-byte buffer | 72 (0x48) | 0x100002d10 reads `[sp+0x48]`; `main` reads `[sp+0x10+0x48]` |
| Failed call | no value (the pid is skipped) | 0x100002d10 `cset/csel` on a non-zero return |
| Pid list size | `proc_listallpids` count + 64, at least 64 | `main` 0x1000029bc (`x8 += 0x40`, `csel … 0x40`) |
| Output | one line per pid: `<pid> <bytes>` | `main` 0x1000029bc (`append(" ")`, `append("\n")`) |
| Fallback when the helper is missing | `/usr/bin/top -l 1 -stats pid,mem`, cached 10 000 ms | JS `aGt`, `wI` (`QWt=1e4`) |
| Helper time limit / output cap | 5 000 ms / 4 194 304 bytes | JS `$Wt=5e3`, `eGt=4194304` |

Kingu (`system.rs` › `footprint`, `memory_of`): reads the same field in-process for every pid under
Kingu and falls back to `ps` RSS where it fails. Before this change Kingu summed RSS, which counts
shared memory again for each process, so its number didn't match Activity Monitor or Orca.

## Workspace Space (added in this round)

Orca IPC: `workspaceSpace:analyze`, `:cancel`, `:getCachedAnalysis`, event `workspaceSpace:progress`.
Kingu: `apps/desktop/src-tauri/src/workspace_space.rs`, `src/lib/ade/WorkspaceSpaceDialog.svelte`
(Tasks board › chart button, or the command **Agents: Workspace Space…**).

| Rule | Value | Source |
|---|---|---|
| Worktrees measured | every `git worktree list` entry except prunable (and bare) | `bsn` (`filter(e=>!e.prunable)`) |
| Size command | `du -k -d 1 <worktree>` | `Tsn` |
| `du` time limit | 120 000 ms | `Csn=12e4` |
| `du` output cap | 16 777 216 bytes | `wsn=16777216` |
| Repos in parallel | 2 | `xsn=2` |
| Worktrees in parallel per repo | 3 | `gsn=3` |
| Local worktrees measured at once | 1 | `Ssn=1` |
| Progress event throttle | 100 ms | `Dsn=100` |
| Top-level items kept | 48; above 48 the first 47 stay and the rest fold into "Other" | worker `a()` |
| Item order | size descending, then name | worker `a()` |
| Reclaimable bytes | 0 for the main worktree, else the whole size | chunk `workspace-space-worktree-row` `T()` |
| Row order | size descending, then name | `Esn` |
| Error buckets | ENOENT/ENOTDIR → missing, EACCES/EPERM → permission-denied, else error | row chunk `_()` |
| Scan state limits | 100 000 entries / 64 MiB (Orca's own walk) | row chunk `r=1e5, i=67108864` — Kingu lets `du` walk instead, so not used |

Kingu differences: one project at a time (the open folder), worktrees measured one after another
(same as Orca's local limit of 1), result kept in memory until the window closes (Orca also writes
it to its profile folder). Removing is not done in the dialog: it opens Kingu's existing Remove Task
or Clean Up Tasks dialogs, each with its own confirmation.

## Sparse checkout (added)

Orca IPC: `sparsePresets:list`, `:save`, `:remove`; creation in `fo` (addSparseWorktree) and `ade`
(worktree add) in `out/main/index.js`. Kingu: `agent/worktree.rs` › `create_named_sparse`,
`normalize_sparse_dirs`; `sparse_presets.rs`; New Task form › Folders.

| Rule | Value | Source |
|---|---|---|
| Steps | `worktree add --no-checkout -b <branch> <path> <base>`, then in it `sparse-checkout init --cone`, `sparse-checkout set -- <folders>`, `checkout <branch>` | `fo`, `ade` |
| On failure | the half-made worktree and its new branch are taken away again | `fo` catch → `co(...)` |
| Folder rule | trim; `\` → `/`; strip leading/trailing `/`; drop empty and `.`; refuse absolute (`/`, `\`, `X:`) and any `..`; drop duplicates | `is`, `jme` |
| Preset name | trimmed, required, at most 80 characters | `aSe` |
| Preset folders | at least one after the folder rule | `oSe` |
| Saving with an existing id | replaces it, keeps its creation time, sets the update time | `rSe` |
| Storage | Orca: its own store per repo; Kingu: `<project>/.kingu/sparse-presets.json` | Kingu choice |

Native code check: `Contents/MacOS/Orca` has no `sparse`, `checkout`, `git` or `preset` string
(0 matches), and `orca-process-footprint`, `orca-keyboard-layout` and `orca-notification-status`
have no `sparse` bytes. `sparse-checkout` appears only in `app.asar`, at file offsets 0x1a7ff1
and 0x1a8038: the `init --cone` and `set --` calls of `fo` above. So there's no native function to
decompile for this feature; the table is the whole rule set, and Kingu's code matches it step for
step (the same git commands in the same order, the same cleanup on failure, the same folder and name rules).

Not built: Orca also allows sparse for best-of-N attempts and for starts from an existing branch or
PR; Kingu offers it for a single new-branch task.

## Project groups and Add Folder of Projects (added)

Orca IPC: `projectGroups:list`, `:create`, `:update`, `:delete`, `:moveProject`, `:scanNested`,
`:importNested`; store in `out/shared/project-groups.js`; scan in `_l`, `gxe`, `_xe`, `Cxe`, `Txe`
(`out/main/index.js`). Kingu: `projects.rs` (groups in projects.json), `project_scan.rs`,
`projects.ts` › `groupSections`, side bar group headers and menus.

Native code check: `Contents/MacOS/Orca` has no `group`, `node_modules`, `gitignore`, `Untitled`,
`scan` or `repo` string (0 matches); `orca-process-footprint` has no `Untitled group`, and
`orca-keyboard-layout` and `orca-notification-status` have no `node_modules`. The scan limits sit in
`app.asar` at file offset 0x1cfca4 (`fxe=3,pxe=100`), and the group rules in
`app.asar.unpacked/out/shared/project-groups.js` (6 702 bytes; the only file holding
`Untitled group`). Both are JavaScript, so there is no native function to decompile; the table
below is read from those two files and Kingu uses each value as written.

| Rule | Value | Source |
|---|---|---|
| Blank group name | `Untitled group` | `normalizeProjectGroupName` |
| New group's order | highest `tabOrder` + 1 | `createProjectGroup` (store) |
| Group order | `tabOrder`, then name | `normalizeProjectGroups` |
| Parent that is itself or unknown | cleared (top level) | `normalizeProjectGroups` |
| Rename to blank | keeps the old name | `updateProjectGroup` › `aA` |
| Delete | the group and all sub-groups; their projects become ungrouped | `deleteProjectGroup`, `getProjectGroupSubtreeIds` |
| Project in a missing group | ungrouped on load | `clearMissingProjectGroupMemberships` |
| Move without an order | last in the group (highest order + 1, 0 when empty) | `getNextProjectGroupOrder` |
| Order inside a group | `projectGroupOrder`, else list place × 1000 | `getEffectiveProjectGroupManualRank` |
| Scan depth | 3 by default, 1–8 | `fxe=3`, `gxe` |
| Scan size | 100 repositories by default, 1–500 | `pxe=100`, `gxe` |
| Scan time | 15 000 ms on import; any limit kept within 500–30 000 ms | `importNested` `timeoutMs:15e3`, `gxe` |
| Picked folder is a repository | not scanned (`git_repo`); Kingu adds it as one project | `_l` |
| Repository marker | `.git` folder or file; a repository isn't looked into | `Txe`, `_l` |
| Always skipped | `node_modules .next dist build .cache vendor __pycache__ .turbo .parcel-cache` and `.git .svn .hg .jj .sl .repo CVS` | `mxe`, `hxe` |
| Dot folders | skipped below the first level | `_xe(name, depth)` |
| `.gitignore` | folders it names are skipped | `wxe`, `Cxe` (Kingu: plain names only, no wildcard patterns) |
| Import | one group named after the folder (`folder-scan`); known projects move into it; group removed when nothing landed | `importNested`, `El` |

Kingu differences: the open folder keeps its own place at the top of the side bar even when it's in
a group; Orca's "separate" import mode (no group) and its nested sub-groups per sub-folder aren't
built; Kingu's 50-project limit still applies, so a bigger import reports the rest as failed.

## Bitbucket (added)

Orca IPC: `bitbucket:connect`, `:status`, `:disconnect` (`zVt`, `FVt`, `LVt`, `PVt` in
`out/main/index.js`); provider code in `out/main/chunks/orcad-migration-source-retention-*.js`
(`uye`, `sg`, `dg`, `fg`, `mg`, `pg`, `Ig`, `Lye`, `Pye`, `ig`, `rg`, `cye`, `ag`, `Kye`, `Wye`).
Kingu: `bitbucket.rs`, `agent/mr.rs` › `Forge::Bitbucket`, `agent/forge.rs`, `agent/mod.rs`,
`src/lib/ade/bitbucket.svelte.ts` (Bitbucket: Connect… / Disconnect). Like the other features,
none of Orca's native programs holds this code.

| Rule | Value | Source |
|---|---|---|
| API root | `https://api.bitbucket.org/2.0` unless set | `PVt`, `Eye` |
| Sign-in | access token → `Authorization: Bearer <t>`; else email + API token → `Basic base64(email:token)` | `fg` |
| Usable credential | an access token, or both email and API token | `dg` |
| Order | environment variables first (Orca `ORCA_BITBUCKET_*`; Kingu `KINGU_BITBUCKET_ACCESS_TOKEN`, `_EMAIL`, `_API_TOKEN`, `_API_BASE_URL`), then the stored one | `ug`, `Dye` |
| Connect check | `GET /user`; 401/403 → rejected, other failures → unreachable | `mg` |
| Account name | `username`, else `display_name`, else `account_id` | `pg` |
| Remote | `git@bitbucket.org:ws/repo(.git)` (also `ssh.bitbucket.org`) or a URL on bitbucket.org; last two path parts | `uye`, `sg` |
| Branch's PR | `GET /repositories/ws/repo/pullrequests?pagelen=1&sort=-updated_on&q=source.branch.name = "<b>" AND (state = "OPEN" OR … "SUPERSEDED")&state=…` | `Lye`, `kye`, `Mye` |
| PR states | MERGED → merged; DECLINED, SUPERSEDED → closed; else open | `rg` |
| Build checks | `GET …/commit/<hash>/statuses/build?pagelen=100` | `Pye` |
| Check states | SUCCESSFUL → success; FAILED, ERROR → failure; STOPPED → cancelled; INPROGRESS, PENDING → pending; else neutral | `cye` |
| Overall | any failed/stopped/error → failure; any running → pending; all successful → success; none → neutral | `ig` |
| Mergeable | reported as UNKNOWN | `ag` |
| Create | `POST …/pullrequests` `{title, description, source.branch.name, destination.branch.name}` | `Kye` |
| Create checks | title and both branches required; base ≠ head (any case) | `Kye` |
| Create errors | 401/403 → connect Bitbucket; "already exists" → a PR exists; 400/422 → rejected | `Wye` |
| Request time limit | 5 000 ms per API request | `Oye=5e3` in `app.asar.unpacked/out/main/chunks/orcad-migration-source-retention-DmkxZy4e.js`; Kingu `REQUEST_TIMEOUT_MS` |
| Connect check time limit | 6 000 ms (`FVt` passes `NVt` to the `/user` check; `mg`'s own default is 4 000) | `NVt=6e3`, `app.asar` offset 0x3c6914; Kingu `CONNECT_CHECK_TIMEOUT_MS` |
| Create time limit | 60 000 ms for `POST …/pullrequests` | `Bye=6e4`, passed in `Kye`; Kingu `CREATE_TIMEOUT_MS` |

Native code check: `Contents/MacOS/Orca` has no `bitbucket`, `pullrequest`, `Bearer`, `Basic` or
`api.` string (0 matches), and none of the three helper programs holds `bitbucket`. All of the
rules above come from Orca's JavaScript at the places named.

Not built for Bitbucket yet (each says "open it on bitbucket.org"): merge, auto-merge, close,
comments, review threads, check logs, reactions, starting a task from a Bitbucket PR. Orca's
Bitbucket provider doesn't do these either, except where its generic review views read them.

## Link previews (added)

Orca IPC `linkPreview:get` (`Wcn` in `out/main/index.js`) → `DNt`/`kNt` in
`app.asar.unpacked/out/main/chunks/orcad-migration-source-retention-DmkxZy4e.js`. Kingu:
`link_preview.rs` (`link_preview_get`), `src/lib/workbench/LinkPreview.svelte` (card on any web
link the pointer rests on).

Native code check: `Contents/MacOS/Orca` has no `og:`, `favicon`, `preview`, `twitter`, `charset` or
`redirect` string (0 matches), and none of the three helper programs holds `og:title`. The limits
are JavaScript constants in `app.asar.unpacked/out/main/chunks/orcad-migration-source-retention-DmkxZy4e.js`
(sha256 0d408884…5e0): `nNt=4,rNt=new Set([301,302,303,307,308])` at offset 0x23a1c6,
`sNt=200,cNt=400` at 0x23a71d, and `mNt=5e3,hNt=1048576,gNt=1048576,_Nt=65536,vNt=6e5,yNt=6e4,bNt=300,xNt=20971520`
at 0x23abb7. Each matches Kingu's constant of the same meaning in `link_preview.rs`
(`MAX_REDIRECTS`, `REDIRECTS`, `TITLE_MAX_CHARS`, `DESCRIPTION_MAX_CHARS`, `TIMEOUT_MS`,
`PAGE_MAX_BYTES`, `IMAGE_MAX_BYTES`, `ICON_MAX_BYTES`, `PAGE_TTL_MS`, `FAILURE_TTL_MS`,
`CACHE_MAX_ENTRIES`, `CACHE_MAX_BYTES`), so no value had to change.

| Rule | Value | Source |
|---|---|---|
| Allowed URLs | http/https, no user name or password, host not internal | `eNt` |
| Internal names | `localhost`, `*.localhost`, `*.internal`, `*.local` | `YMt`, `$Mt` |
| Internal addresses | 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4; ::, ::1, 64:ff9b:1::/48, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, fec0::/10, ff00::/8; IPv4 inside ::ffff:, ::, 64:ff9b:: judged as IPv4 | `V3`, `JMt`, `XMt` |
| Name lookups | every resolved address checked; Kingu also pins the connection to them | `tNt` |
| Redirects | 301, 302, 303, 307, 308; at most 4; each target checked again | `rNt`, `nNt=4`, `aNt` |
| Whole time limit | 5 000 ms | `mNt=5e3` |
| Page | `text/html`, `application/xhtml+xml`; at most 1 048 576 bytes; read until `</head>` | `SNt`, `hNt`, `oNt` |
| Fields | title: og:title, twitter:title, else `<title>`; description: og:description, twitter:description, description; site: og:site_name; picture: og:image, og:image:secure_url, twitter:image | `fNt` |
| Text limits | title and site 200 characters, description 400; longer → first n−1 + `…` | `sNt`, `cNt`, `H3` |
| Nothing to show | no title and no description → no card | `kNt` |
| Picture | png, jpeg, gif, webp, avif; at most 1 048 576 bytes | `CNt`, `gNt` |
| Icon | `<link rel=icon>` else `/favicon.ico`; also ico and svg; at most 65 536 bytes (inline `data:` up to twice that) | `wNt`, `_Nt`, `ANt` |
| Charset | from the header, else `<meta charset>`/`http-equiv`, else UTF-8 | `lNt`, `uNt`, `dNt` |
| Cache | key = URL without `#…`; page 600 000 ms, failure 60 000 ms; at most 300 entries and 20 971 520 bytes, oldest first | `ONt`, `vNt`, `yNt`, `bNt`, `xNt`, `ENt` |
| Hover delay | 600 ms before asking (Kingu's choice; Orca's card opens from its own hover component) | **estimated** |

## Localhost labels (added)

Orca IPC `localhostWorktreeLabels:register` (`Gcn`, `Kcn`, `qcn` in `out/main/index.js`); relay
`XAe` with `ZAe`, `QAe`, `$Ae`, `eje` (index.js); naming `kO`, `LBe`, `RBe`, `zBe`, `EO`, `OO`
(`app.asar.unpacked/.../orcad-migration-source-retention-DmkxZy4e.js`). Kingu:
`localhost_labels.rs` (`localhost_label_register`), Ports panel › globe button "Open with Task
Name" (opens it in Kingu's browser tab of that task).

Native code check: `Contents/MacOS/Orca` has no `localhost`, `proxy`, `label`, `forwarded` or
`127.0.0.1` string (0 matches), and none of the three helper programs holds `.orca.localhost`. The
rules are JavaScript: `var YAe=\`.orca.localhost\`` at `app.asar` offset 0x216edf (the relay class
`XAe` follows it), and `FBe=48,IBe=/(?:^|[-_\s/])main$/i` at offset 0xdac22 of
`app.asar.unpacked/out/main/chunks/orcad-migration-source-retention-DmkxZy4e.js`. Kingu's
`is_main_name` now follows that pattern exactly (any whitespace before `main`, not only space and
tab, which an earlier version accepted).

| Rule | Value | Source |
|---|---|---|
| Why | each task's server gets its own host name, so cookies and storage aren't shared across ports of `localhost` | `XAe` |
| Address | `http://<label>.orca.localhost:<relay port>/<same path and query>`; Kingu: `.kingu.localhost` | `YAe`, `buildLabeledUrl` |
| Relay | HTTP server on 127.0.0.1, port chosen by the system | `ensureServer` (`listen(0,"127.0.0.1")`) |
| Label | the worktree folder's last part as a slug; the main checkout → `<project>-main` | `LBe`, `RBe`, `IBe` |
| Slug | trim, lower-case, drop `'` `"`, other runs of non `a-z0-9` → `-`, trim `-`, at most 48 characters, `workspace` when empty | `kO`, `FBe=48` |
| Main checkout | worktree named `main`, or ending in `-main`, `_main`, ` main`, `/main` | `IBe=/(?:^\|[-_\s/])main$/i` |
| Same task, same target | keeps its label | `zBe`, `routeKeys` |
| Taken label | `-2` … `-999`, then an error | `nextAvailableLabel` |
| Targets | `http` only; on this machine (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `::`); `0.0.0.0` → `127.0.0.1`, `::` → `::1` | `ZAe`, `EO`, `OO`, `Kcn` |
| Forwarding | `Host` = target host, `X-Forwarded-Host` = label host; WebSocket upgrades passed through | `eje`, `handleUpgrade` |
| Unknown label / failed target | 404 "Unknown … localhost label." / 502 "Proxy failed …" | `handleRequest` |

Kingu differences: Orca also checks a non-loopback target against its port scan; Kingu only accepts
this machine's addresses, so that check isn't needed. Each relayed request closes its connection
(`Connection: close`) so every request is routed by its own `Host`.

## SSH hosts (first part added)

Orca IPC `ssh:listTargets`, `:addTarget`, `:removeTarget`, `:importConfig`, `:listConfigHosts`,
`:resolveConfigHost`, `:testConnection`, `:addPortForward`, `:removePortForward`,
`:listPortForwards` (`u4e`, `J2e`, `Y2e`, `X2e`, `e4e`, `t4e` in `out/main/index.js`); config
reading `Lo`, `Ro`, `Uo`, `Wo`, `Go`, `qo`, `Jo`, `Xo` in `out/main/chunks/ssh-managed-port-forward-restore-D6snsTBF.js`.
Kingu: `ssh_hosts.rs`, `src/lib/ade/SshHostsDialog.svelte`, commands **SSH: Hosts…**,
**SSH: Import Host from SSH Config…**, **SSH: Add Host…**.

Native code check: `Contents/MacOS/Orca` has no `ssh`, `known_hosts`, `ProxyJump`, `forward` or
`identity` string (0 matches); none of the three helper programs holds `ssh` or `.ssh/config`;
`Resources/bin/orca` is a 900-byte shell script and `Resources/relay/` holds only WSL files. The
rules are JavaScript: `var Io=5e3;` at offset 0x14d9f of
`app.asar.unpacked/out/main/chunks/ssh-managed-port-forward-restore-D6snsTBF.js` (sha256
6817922b…147b), and the 100-row listing (`c.length<100&&c.push(e4e(t,r,p))`) at `app.asar` offset
0x2afca7.

| Rule | Value | Source |
|---|---|---|
| Config file | `~/.ssh/config` | `Lo` |
| Includes | read where they stand, relative to `~/.ssh`; `*` within one folder; `~`, `%`, `?`, `[` not followed; at most 32 files | `Uo` (`e<32`), `Go`, `Ho` |
| Words | quotes group words, `\` before a space keeps it | `Wo` |
| Listed hosts | concrete `Host` aliases only (no `*`, `?`, `!`), first definition wins | `cn`, `J2e` |
| Listing | query matches alias, host name or user; at most 100 rows, `hasMore` past that; already-added marked | `J2e` (`c.length<100`), `t4e` |
| Row defaults | host name = alias when unset; port 22; user empty | `e4e` |
| Resolve | `ssh -G -- <alias>`, 5 000 ms; `-F $HOME/.ssh/config` is added only when that file exists and `$HOME` isn't the account's own home (ssh reads the account's config by itself) | `Ro`, `Lo`, `qo`, `Io=5e3` (ssh chunk offset 0x14d9f) |
| Resolve parsing | `key value` lines; `IdentityFile none` dropped; `ProxyCommand none`/`ProxyJump none` = none; port 22 when missing; no host name → nothing | `Jo`, `Xo` |
| Connection test | Orca connects then disconnects (`connect(target,{probe:true})`); Kingu runs `ssh -o BatchMode=yes -o ConnectTimeout=10 -T … true`, at most 15 000 ms, never prompting | `ssh:testConnection`; Kingu's limits **estimated** |
| Terminal | a terminal tab running `ssh` to the host (Orca's `plainSsh:open`) | `x2e` |
| Port forward | local port → remote host:port through the host; Kingu runs `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:<local>:<host>:<port>`, failing when ssh quits within 1 s | `ssh:addPortForward` (`addForward(localPort, remoteHost, remotePort)`) |
| Removing a host | its port forwards stop (and their saved records go) | `l4e` |
| Files on the host | `cd <dir> && pwd && entries=$(command ls -1A) && …` printing each entry, a folder (by `[ -d ]`, so links to folders count) with a trailing `/`; a folder that can't be opened is an error | `ssh:browseDir` → `TAt` at offset 0x230a35 of the provider chunk → `DAt`, `EAt` |
| Folder words | `~` → `"$HOME"`, `~/x` → `"$HOME"/'x'`, else quoted | `AAt` |
| Windows hosts | when the POSIX listing fails, a PowerShell one: `/` lists the drives (`C:/` …), `~` is `$HOME`, `/C:` is `C:/`; the resolved folder printed with `/`; when that fails too, the first error is shown | `OAt`, `jAt`, `MAt`, `TAt` |
| Browse time limit | 15 000 ms | `CAt=15e3` at offset 0x2309ba of the provider chunk |
| Kingu only | folders listed before files; at most 500 entries shown; "Terminal here" opens `ssh -t … 'cd -- <dir> && exec "${SHELL:-sh}" -l'` | **estimated** (Kingu's UI) |
| Listening ports on the host | each one click from a forward to the same local port (next free one if taken); ssh's own 22 left out. Orca gets them from its remote server (`ssh:listDetectedPorts`); Kingu asks the host: `ss -ltnH`, else `netstat -ltn`, else `lsof -iTCP -sTCP:LISTEN` | `ssh:listDetectedPorts`; Kingu's method **estimated** |
| Saved forwards | every started forward is remembered; after a restart the ones not running are offered (Restore / Forget); stopping one by hand forgets it; the same local port replaces the old record | `ssh:listUnrestoredPortForwards`, `ssh:removeSavedPortForward` |

Not built yet (Orca's larger remote system): Orca's remote server (`orcad` / relay) with its file
watching, on-demand VMs and runtime environments. Passphrase prompts: see SSH worktrees › Prompts.
Projects on the host: see the next section.

## Projects on SSH hosts (added)

Read from Orca's source (github.com/stablyai/orca at commit 9103a362, `/Users/bright/src-ref/orca`).
Kingu: `src-tauri/src/ssh_projects.rs` (commands `ssh_projects_list`, `ssh_project_add`,
`ssh_project_remove`, `ssh_project_worktrees`, `ssh_project_worktree_add`,
`ssh_project_worktree_remove`, `ssh_project_terminal`), the `host` field of `projects.rs`'s
`Project`, `src/lib/ade/sshProjects.ts` / `sshProjects.svelte.ts` / `SshProjectsSection.svelte`
(side bar, under the project groups), **Add as project** in SSH Hosts › Files, palette command
**SSH: Open Project on SSH Host…**.

| Rule | Value | Source |
|---|---|---|
| Record | the project list's own record with the host's id (Orca's `connectionId`); Kingu: `host` in `projects.json`, absent for this computer | `src/shared/repo-types.ts` (`Repo.connectionId`) |
| Adding | pick an SSH host, then a host path (typed, starting at `~`, or chosen in the remote file browser) | `src/renderer/src/components/sidebar/project-admission/dialog/AddRepoRemoteStep.tsx:RemoteStep` ("Open project on SSH host", "Host path", browser `initialPath={remotePath \|\| '~'}`) |
| Folder → project | the folder's repository top level; a linked worktree becomes its main checkout; not a repository → refused | `src/main/ipc/repos/local-repo-registration.ts:addLocalRepoFromPath` (`mainRepoPath`); Kingu runs `git rev-parse --show-toplevel` and `--git-common-dir` on the host |
| Already added | same host and same path; the same path on another host (or this computer) is another project | `src/main/ipc/repos/nested-repo-import-handler.ts` (`(repo.connectionId ?? null) === (args.connectionId ?? null)`), `local-repo-registration.ts` (`!repo.connectionId`) |
| Local readers | every reader of local folders (tasks, worktrees, nested import, the open-folder check) skips host projects | Kingu: `Projects::list` / `check` filter on `host` |
| Worktree place | a repo-relative layout stays relative to the repository on the host (an absolute desktop folder would not exist there); Kingu's layout is repo-relative, so `<root>/.kingu/worktrees/<slug>` as on this computer | `src/main/ipc/worktree-logic.ts:computeRemoteWorktreePath` |
| Worktree command | `git worktree add --no-track -b <branch> <path> <base>`; Kingu first resolves the base to a commit, refuses an existing folder and a bad branch name (`check-ref-format`), adds `.kingu/` to `info/exclude` once | `src/main/git/worktrees/creation/worktree-add.ts:performAddWorktree`; checks as in Kingu's `agent/worktree.rs` |
| Branch and slug | `kingu.worktree.branchPrefix` + slug from the task name (same as local tasks) | Kingu (`agent/worktree.rs`, `slugify`) |
| Status | one ssh call: `git worktree list --porcelain`, then `git status --porcelain=v1 --branch` per worktree → branch, changed files, ahead/behind | Kingu, **estimated** (Orca reads status through its remote server) |
| Background commands | `ssh -o BatchMode=yes -o ConnectTimeout=10 -T <dest> 'sh -c …'`, 15 s (listing), 120 s (worktree add/remove) | Kingu, **estimated** (limits) |
| Terminal | `ssh -t <dest>` running, through `sh -c`, `cd -- <dir>` then `exec "${SHELL:-sh}" -l`; no `-T`, no `BatchMode`, so the terminal itself may ask for a passphrase | `src/main/ssh/plain-ssh-terminal/plain-ssh-terminal-args.ts:buildPlainSshTerminalArgs` (no -T, BatchMode or ControlMaster for interactive login) |
| Agent | the agent command (`kingu.agent.cli` + its arguments, each word quoted) run by the user's shell with `-lc`, but `-c` for `sh`, `dash`, `csh`, `tcsh`; a login shell stays open after it | `src/main/ssh/remote-exec/ssh-login-shell-command.ts:buildSshLoginShellCommand` (`COMMAND_ONLY_SHELLS`); staying open is Kingu's, **estimated** |
| Which folders get a terminal | the project root and its `.kingu/worktrees/<slug>` folders only | Kingu, **estimated** |
| Removing a worktree | `git worktree remove [--force]`; the branch stays; one with changes asks first | Kingu, **estimated** |
| Removing the project | the record only; nothing on the host changes; a project whose host was removed shows "SSH host removed" | Kingu, **estimated** (Orca: `repos:removeForHost`) |

Terminals of host projects now open in the floating workspace (see the next section), so they no
longer need a local folder open.

## SSH worktrees: files, Source Control, PRs, agent status (added)

Read from Orca's source (github.com/stablyai/orca at 9103a362, `/Users/bright/src-ref/orca`). Orca
runs a server on the host (`orcad` / relay) that serves files, git and agent hooks; Kingu has none:
every call is one `ssh -o BatchMode=yes -o ConnectTimeout=10 -T <dest> 'sh -c …'` (never prompting).
Kingu: `src-tauri/src/ssh_remote.rs` (commands `ssh_remote_dir`, `_read`, `_write`, `_status`,
`_diff`, `_stage`, `_commit`, `_push`, `_branches`, `_presets`, `_pr_create`, `_discard`, `_sync`,
`_files`, `_grep`, `_poll`, `_hook_read`, `_hook_clear`), `ssh_askpass.rs` (prompts:
`ssh_submit_credential`, `ssh_needs_passphrase_prompt`, `ssh_pending_credentials`), `ssh_hosts.rs`
(`background`, `mux_args`), `ssh_projects.rs` (sparse/base in `create_script`, claude hooks in
`with_hooks`), `src/lib/ade/sshRemote.ts` (pure rules), `sshCredentials.svelte.ts`, `sshWorkspace.svelte.ts` +
`SshRemoteFolder.svelte` (the open remote folder), `sshProjects.svelte.ts` (terminals, agent status,
new task), `floating.svelte.ts` (`newTerminal({ run, watch })`). Palette: **SSH: Open Remote
Folder…**, **SSH: New Remote Terminal…**; side bar: the folder button on a host worktree.

| Rule | Value | Source |
|---|---|---|
| Which folders | the project root or one of its `.kingu/worktrees/<slug>`; file paths relative to it, no `..`, no `.git` part, no control characters | Kingu (`check_rel`, `inside_project`), **estimated** |
| File tree | one folder per call (`cd <dir> && ls -1A` with `[ -d ]`, as SSH Hosts › Files), `.git` hidden, folders first, 500 entries | Orca `readDir` of `src/main/providers/filesystem/provider-contract.ts`; listing as `ssh:browseDir`; order and limit **estimated** |
| Reading a file | its size, then its bytes as base64 (any bytes survive); over 2 MB → "too large"; NUL or not UTF-8 → binary, not shown | Orca `readFile(filePath, limits)` (`maxTextBytes`); Kingu's 2 MB and binary test **estimated** |
| Saving a file | the text goes on ssh's stdin (never in the command line); written to `<file>.kingu-save.<pid>` first, then copied over the old file (mode and owner kept) or moved into place with its folders made; ⌘S in the editor | Orca `writeFile(filePath, content)`; the temp-then-copy is Kingu's, **estimated** |
| Source Control | `git status --porcelain=v1 -z --branch --untracked-files=all`; X letters → Staged, Y letters and `??` → Changes, conflicts (`UU`, `AA`, …) once as `!` | Orca `getStatus` (`src/main/providers/git/provider-contract.ts`); grouping as VS Code |
| Diff | Staged: last commit ↔ index (`git show HEAD:./f`, `git show :./f`); Changes: index (else last commit) ↔ the file; a missing side is empty; each side cut at 2 MB | Kingu, **estimated** (Orca reads both sides through its server) |
| Stage / unstage | `git add -A -- <paths>`; `git reset -q HEAD -- <paths>`, or `git rm -r -q --cached` before the first commit; a rename takes its old path along | Orca `stageFile`, `unstageFile`, `bulkUnstageFiles` |
| Commit | `git commit -q -F -` with the message on stdin, staged files only; an empty message is refused | Orca `commit(worktreePath, message)` |
| Push | `GIT_TERMINAL_PROMPT=0 git push -q -u origin HEAD` on the host (its credentials), 120 s | Kingu, **estimated** (same push as `forge.rs push_head`) |
| Create PR | origin's URL and branch read on the host, the branch pushed there, then the request sent from this computer: GitHub `gh pr create --repo [host/]owner/repo --head <branch> --base … --title … --body …` (run outside any local repository), GitLab merge request (`mr.rs`, fork parent kept), Bitbucket (`bitbucket.rs`); `origin/` dropped from the base | `src/main/github/client/create/create-github-pull-request.ts` ("`gh` runs on this client whatever the host; only the git reads under it are routed") |
| New task: base | origin's default (`refs/remotes/origin/HEAD`) first, then every local and remote-tracking branch; "current HEAD" keeps the old behaviour | Orca `resolveWorktreeCreateBase` in `src/main/ipc/worktree-remote.ts` (requested base, else the repo default) |
| New task: sparse checkout | the project's presets, read from `<root>/.kingu/sparse-presets.json` on the host (where a local project keeps them), typed folders, or the whole tree; `worktree add --no-checkout`, `sparse-checkout init --cone`, `sparse-checkout set -- <folders>`, `checkout <branch>`; a failed step removes the worktree and branch | `src/main/git/worktrees/creation/worktree-sparse-add.ts`, `src/main/ipc/worktree-remote.ts` (`addSparseWorktree`, `normalizeSparseDirectories`); presets on the host **estimated** |
| Agent status | Orca: hooks post to a relay on the host and win; the program's own report in the terminal stream fills in "for a fresh SSH host". Kingu: a `claude` started on the host gets the per-session hooks a local one gets, through `--settings` (nothing in the host's claude settings changes), each hook appending its payload to `$HOME/.kingu/agent-hooks/<token>.jsonl` there; Kingu reads new lines over ssh every 2 s (`tail -c +<offset>`, 1 MB at most) and applies them like local hooks (`agentHooks.ts`). Only the events every claude knows (the host's version isn't probed: Orca's floor). Fresh hooks win; else the terminal title (OSC 0/2, `agentTitle.ts`), else output in the last few seconds = working; `SessionEnd`, a shell title after an idle one, or the tab closed = gone; the file is removed when the tab closes | `src/main/agent-hooks/README.md` (two channels, precedence), `src/main/agent-hooks/server/server-ingest-remote.ts`; the file + ssh read and the 2 s poll **estimated** |
| Notifications | the same rules as local tasks (`agentNotify.ts noticeFor`, the `kingu.agent.notifications*` settings): needs you, finished a turn, failed | Kingu (Orca's notifications) |
| Terminals | tabs of the floating workspace (no local folder needed), the `ssh -t` command typed into a local shell; agent tabs are followed for status | Kingu, **estimated** (Orca shows remote terminals in the worktree's own panes) |
| Remote folder | the worktree opened as the folder you work in: a window-sized view with file tree, editor, diff and Source Control; the last one opened comes back on start when no local folder is open | Kingu, **estimated** (Orca activates a remote repo's worktree like a local one) |

| Discard | per file: tracked → `git restore --worktree` (else `git checkout`), untracked → `git clean -f`; literal pathspecs; asks first ("cannot be undone") | `src/main/git/source-control/mutations/discard-changes.ts:discardChanges` |
| Fetch / Pull | `git fetch -q --prune origin`; `git pull -q` with the host's own pull settings; `GIT_TERMINAL_PROMPT=0`, 120 s | Orca `fetchRemote`, `pullBranch` (`src/main/git/remotes/remote.ts`) |
| Go to File | `git ls-files --cached --others --exclude-standard` (tracked + untracked, not ignored), at most 50 000, picked in the quick picker | Orca `listFiles` (filesystem provider); limit **estimated** |
| Search | `git grep -z -n -I -F [-i] --untracked -e <text>`, binary files skipped, 500 hits, 300 characters a line; a hit opens the file at its line | Orca `search` (filesystem provider, ripgrep on its server); Kingu's `git grep` and limits **estimated** |
| Auto-refresh | no watcher on the host: every 5 s while the window shows and no git action runs, one ssh call returns git status and the open file's `cksum`; a new status re-reads git and the open folders, a new checksum re-reads a file without unsaved edits | Orca's server watches (`watch` in the filesystem provider); Kingu's poll **estimated** |
| Shared connection | background calls use `ControlMaster=auto`, `ControlPath=~/.ssh/kingu-%C`, `ControlPersist=120` (Unix, when `~/.ssh` exists; a socket path must stay under 104 bytes); the connection test and port forwards never share | Kingu, **estimated** (Orca keeps one ssh2 connection per host) |
| Prompts | ssh's passphrase / password / host-key questions reach the app: `SSH_ASKPASS` = Kingu's helper with `SSH_ASKPASS_REQUIRE=force`; the helper makes a FIFO in a 0700 folder, leaves `<id>.req` (host and prompt, no secret), and blocks on the FIFO; Kingu's watcher asks the window (quick input, hidden for secrets), the answer goes `1<value>` / `0` (Cancel) through the FIFO, never to a file; the command's time limit pauses while a prompt is open | `src/main/ipc/ssh/ssh-passphrase.ts` (`ssh:credential-request`, `ssh:submitCredential`), `ssh-connection-handlers.ts` (`ssh:needsPassphrasePrompt`); FIFO helper **estimated** |
| Prompt rules | 120 s, then declined; Cancel declines the host and cancels its other queued prompts; a declined host runs `BatchMode=yes` (no prompt) until SSH Hosts › Test; secrets kept in memory for the run and reused; a reused one ssh asks again within 10 s is dropped and asked | `SSH_CREDENTIAL_TIMEOUT_MS = 120_000` (`src/main/ssh/connection/ssh-connection-timing.ts`), `recordSshCredentialDeclined`, `clearSshCredentialDeclined`, `hasCachedCredential`; the 10 s retry rule **estimated** |

Note: the user's own ssh config still applies (e.g. macOS `UseKeychain yes` / `AddKeysToAgent yes`
store a typed passphrase in the keychain or agent; that is ssh's doing, not Kingu's).

Verified against a real sshd (`ssh_remote::tests::e2e_over_a_real_ssh`, run with
`KINGU_SSH_E2E_DIR=<dir> cargo test --lib ssh_remote::tests::e2e -- --ignored`; the folder holds
`plain` and `locked` keys, `kh` and a user-mode `/usr/sbin/sshd` on port 22222).

### A host worktree as the IDE's open folder (added)

Orca sends each filesystem and git call to the local provider or the SSH one
(`src/main/providers/execution-host-provider-dispatch.ts`; contracts
`src/main/providers/filesystem/provider-contract.ts`, `src/main/providers/git/provider-contract.ts`).
Kingu: `src-tauri/src/remote_ws.rs` (the SSH side), `workspace.rs` (`WindowSession.remote`,
`Workspace::remote()`), `windows.rs` (`workspace_open_remote`, `WorkspaceState.remote`), the
dispatching commands in `lib.rs`, `git_repos.rs`, `git_remote.rs`, `git_editor.rs`;
`workspace.svelte.ts` (`remote`, `openRemote`, the poll), `lsp.svelte.ts` (`remote`). Open it with
**SSH: Open Remote Folder…** or the folder button on a host worktree in the side bar.

| Rule | Value | Source |
|---|---|---|
| The session | the window's session holds the host, the project root and the worktree; its local folder list is empty, so `ws.root()` refuses ("Not available yet for a folder on an SSH host") in every command without a remote side, and nothing local is ever touched by mistake; saved and restored with the window | Orca's `connectionId` on the repo; refusal **estimated** |
| Root name | `ssh://<host id><path>` (never a local path); files inside by their relative path, as for a local folder; title `app [host]` | Kingu, **estimated** |
| Files | Explorer listing (`ls -1A`, `git check-ignore --stdin` for dimming), open (size, then base64; the text file service's own decoding, encodings and binary / large-file rules; at most 50 MB over ssh), save (encoded here, sent on stdin to a temp file, then copied over), new file, new folder, rename, delete (for good: no trash on the host; the Explorer asks first) | Orca `readDir`, `readFile`, `writeFile`, `createFile`, `createDir`, `rename`, `deletePath` |
| Save conflicts | no mtime over ssh: a save is refused as a conflict when the file's SHA-256 on the host differs from what the editor loaded | Kingu, **estimated** (local saves compare mtime, then content) |
| Quick Open | `git ls-files --cached --others --exclude-standard`, 20 000 files | Orca `listFiles` |
| Search (view, Search Editor, Quick Open `%`) | ripgrep on the host when it has one, with exactly the local arguments and JSON (`search.rs build_args`, `RgParser`); else `git grep -z -n -I --untracked` (`-F`/`-E`, `-i`, `-w`) with matches found here; 20 MB of output read at most; results arrive as one batch | Orca `search` (its server's ripgrep); fallback **estimated** |
| Source Control | one repository (the worktree); status with the local `git status` arguments and parser (`git.rs status_args`, `parse_status`), remotes, operation markers; diff sides (`git show HEAD:./f`, `:./f`); stage, unstage, discard (untracked only after the confirm), commit (local `commit_flags`, message on stdin), fetch, pull, push / publish, sync | Orca git provider `getStatus`, `stageFile`, `unstageFile`, `discardChanges`, `commit`, `fetchRemote`, `pullBranch`, push |
| Status bar branch | from the remote status | Kingu |
| Changes on the host | no watcher there: every 5 s (window shown) one ssh call reads git status; files whose status changed refresh the Explorer, Source Control and open editors; edits to a file already modified, and changes to ignored files, are not seen until Refresh | Orca's server watches; poll **estimated** |
| Terminals | a terminal of the window types `ssh -t … 'cd -- <worktree>; exec $SHELL -l'` into a local shell started in the home folder; a command it was opened for runs on the host; floating terminals stay local | `plain-ssh-terminal-args.ts` (as SSH project terminals) |
| Language servers | not started (they would run here against files they can't read): "not available on remote" | Kingu, **estimated** (Orca runs them on its server) |
| Tested | against a real sshd: `remote_ws::tests::e2e_remote_workspace` with `KINGU_SSH_CONFIG=<test config>` (an ssh config for host `kingu-e2e`: `IdentityAgent none`, `AddKeysToAgent no`, `UseKeychain no`, its own known hosts), `cargo test --lib e2e -- --ignored`; `KINGU_SSH_CONFIG` makes every background ssh use that file (`-F`) | Kingu |

Still only on the Remote Folder page (`SSH: Open Remote Folder Page…`) or not on remote yet: Create
Pull Request for the worktree (page only), language servers, tasks and the ADE board (task
worktrees of an SSH project are made from the side bar), branches / log / stash / blame / graph /
timeline / local history, image preview, copy / move / paste between folders, debugging. Each
refuses with "Not available yet for a folder on an SSH host".

## Workspace Ports (already in Kingu, checked against Orca)

Orca IPC: `workspacePorts:scan`, `:kill`, `:probePage`. Kingu: `AdePortsPanel.svelte`, `system.rs`.

| Rule | Value | Source |
|---|---|---|
| Listening sockets (macOS) | `lsof -nP -iTCP -sTCP:LISTEN -F pcnd`, then `lsof -a -p <pids> -d cwd -Fn` and `ps -p <pids> -o pid= -o command=` | `Dcn`, `icn` |
| Owner | worktree whose path is the longest prefix of the process cwd; else whose path appears as a word in its command line | `Rsn`, `Gsn`, `qsn` |
| Kinds and order | workspace, then container, then external; then port, then host | `zsn`, `Vsn` |
| Max rows | 200 | `Fcn=200` |
| Guessed http ports | 80, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888 | `Psn` |
| Guessed https ports | 443, 8443 | `Fsn` |
| Stop | SIGTERM, only workspace-owned, never Orca itself | `_H` |
| Slow-scan cooldown | 60 s doubling to 300 s after a timeout | `acn=6e4`, `ocn=3e5` |

## Screenshot option

`kingu-desktop --screenshot <file.png>` waits for a visible window (at most 60 s), lets it draw
2 s (about 120 frames at 60 Hz), saves the page with WKWebView's snapshot and quits; it gives up
after 120 s. Values are Kingu's own (estimated, not from Orca).

## Mobile pairing (added)

Read from Orca's source (github.com/stablyai/orca at 9103a362), checked against the shipped
1.4.253 bundle. Orca IPC `mobile:listNetworkInterfaces`, `:getPairingQR`, `:listDevices`,
`:revokeDevice` (`src/main/ipc/mobile.ts`). Kingu: `src-tauri/src/mobile.rs` (server, codes,
devices), `mobile_web.html` (the phone page), `src/lib/ade/mobile.svelte.ts` +
`MobilePairDialog.svelte` (palette: **Mobile: Pair Device…**).

| Rule | Value | Source |
|---|---|---|
| Server port | 6768; a taken port falls back to a free one | `DEFAULT_WS_PORT`, `runtime-rpc-pairing-types.ts`; fallback `runtime-rpc-websocket-fallback-port.test.ts` |
| Code lifetime | 10 min (`MOBILE_PAIRING_OFFER_TTL_MS`) | `pairing/pairing-offer-expiry.ts` |
| Reuse of the shown code | reused while more than 60 s are left, else a new one; Regenerate always makes a new one | `PAIRING_OFFER_REUSE_MARGIN_MS`, `reusablePairingOffer` |
| Dialog refresh | a shown code is replaced 60 s before it expires | `PAIRING_OFFER_REFRESH_LEAD_MS`, `renderer/src/components/mobile/use-pairing-offer-expiry.ts` |
| Device token | 24 random bytes as hex; device id random | `pairing/device-credential.ts` |
| Code is single use | the pairing ticket is exchanged once for the device's own credential | `runtime-rpc-pairing-ticket-exchange.ts`, `paired-mobile-devices.ts` ("single-use pairing codes") |
| Default device name | `Mobile <date>` | `requestMobilePairingOffer`, `pairing/pairing-offer-requests.ts` |
| Name length | at most 128 characters | `DELEGATED_PHONE_NAME_MAX_CHARS`, `shared/delegated-mobile-device-contract.ts` |
| Addresses offered | not internal, not 198.18/15 (proxy fake IPs), IPv6 only when not link-local | `getPairingNetworkInterfaces`, `pairing/network/pairing-network-interfaces.ts` |
| Address order | tailnet 100.64/10 first (0), IPv4 (1), IPv6 (2); virtual bridges +2 | `rankInterface`; `isTailnetIPv4Address`, `shared/tailnet-address.ts` |
| Virtual bridges | names `docker`, `br-`, `virbr`, `vmnet`, `vboxnet`, `veth`, `lxcbr`, `cni`, `flannel`, `cali`, `bridge`, VMware/VirtualBox adapters | `isVirtualBridgeInterface`, `shared/pairing-address-auto-selection.ts` |
| Address picked by default | bridges never; a tailnet address first, else the first one left; none → "connect to Wi-Fi or Tailscale, or pick an address" | `selectAutoAdvertisedPairingAddress`; message in `pairing-offer-requests.ts` |
| Custom address | the user can type one ("Add custom address…") | `use-mobile-pairing-custom-address.ts` |
| QR | error correction M, 4-module quiet zone | `encodeMobilePairingQr`, `pairing/mobile-pairing-qr.ts` |
| Pairing link | the secret goes in the URL fragment (`#pairing=…`), so it is never sent in a request | web client URL in `runtime-rpc-pairing-types.ts` (`/web-index.html#pairing=`) |
| Listening | not on the network until pairing asks for it (Orca widens 127.0.0.1 → 0.0.0.0 on the first code) | `ensureNetworkExposure`, `runtime-rpc-network-exposure.ts` |
| Failed sign-ins | 3 failures within 60 s → one warning to the user (once per server run) | `UnpairedDeviceAuthThrottle`, `runtime/rpc/mobile/unpaired-device-auth-throttle.ts` |
| Device list / revoke | paired devices with paired and last-seen times; Revoke removes it at once | `mobile:listDevices`, `mobile:revokeDevice`, `revokeMobileDevice` |
| Task order on the phone | needs you, working, finished, others; newest first within each | `AGENT_ATTENTION_STATUS_ORDER`, `mobile/src/worktree/workspace-list-ordering.ts` |
| Tasks grouped by project | yes | `buildProjectSections`, `mobile/src/worktree/workspace-list-sections.ts` |

Kingu's own choices (**estimated**, not from Orca):

| Choice | Value |
|---|---|
| Transport | plain HTTP JSON + a web page served by Kingu (no phone app); Orca uses an end-to-end encrypted WebSocket RPC to its native app, plus a cloud relay |
| Off by default | the server doesn't run at all until "Allow phones to connect" is on; it then binds 0.0.0.0 (IPv4 only); the setting and devices live in `mobile.json` (mode 0600) in the app data folder |
| Typed code | 10 characters of Crockford base32 (50 bits), shown `XXXXX-XXXXX`; O→0, I/L→1, dashes ignored; 5 wrong tries kill the code |
| Token storage | only the SHA-256 of each device token is stored; compared without early exit |
| Unauthenticated | only the page itself (no data) and `/api/pair` (needs the live code); `/api/tasks`, `/api/send`, `/api/unpair` need `Authorization: Bearer` |
| Host check | `Host` must be an IP address or `localhost` (stops DNS rebinding); no CORS headers; POST needs `application/json` |
| Page headers | CSP with a per-response nonce, `no-store`, `nosniff`, `no-referrer`, `X-Frame-Options: DENY` |
| Limits | head 16 KB, body 64 KB, message 16 000 characters, 16 connections, 10 s read time, one request per connection |
| Last seen | written to disk at most once a minute per device |
| Link-local IPv4 | 169.254/16 not offered |
| What the phone can do | see every project's tasks (status, agent, prompt, last run summary), refresh every 3 s, send a message to a task's agent (goes through `adeTasks.followUp` in the window that has the project open, 20 s limit), answer the agent's permission prompt or question, forget itself |
| Live status | the window that has a project open pushes its agents' live state (`mobile_live`: phase working / permission / question / idle / ended, the hook's one-line message, the question's options) on every change (300 ms debounce) and every 10 s while the server runs; Rust lays it over tasks.json and drops it 30 s after the last push (`LIVE_TTL_MS`), so a closed window falls back to the saved status. At most 500 rows per window, 300 characters per line |
| Answers | `POST /api/answer` `{root, slug, answer: allow \| deny \| question, selections}`: refused (409) unless that task's live row shows that very prompt open. Allow types Enter (the CLI's highlighted first choice, "Yes"/"Allow once"), Deny types Esc; a question goes through the desktop quick reply's keystrokes (`cliSessions.answer`, Orca's `buildAskAnswerKeys`) |
| Phone page language | Kingu's language (Rust catalog `MobileWebMsg`) |

Not built: Orca's native app features (terminals, diffs, git actions, creating worktrees,
push notifications), the relay for use outside the local network,
end-to-end encryption, Windows firewall repair, the Android emulator (`emulator`).

## Orca systems Kingu still lacks (from Orca's 853 IPC handlers)

Checked by searching Kingu's code for each Orca IPC namespace; "missing" means no code was found.
This table only says whether a system exists; `docs/ADE-PARITY.md` compares the ADE feature by
feature, by behaviour.

| Orca system (IPC namespace, handler count) | In Kingu |
|---|---|
| Sparse checkout presets for new worktrees (`sparsePresets`, 3) | **added** (see Sparse checkout) |
| Project groups: user folders of projects, nested repo import (`projectGroups`, 8) | **added** (see Project groups) |
| Bitbucket pull requests (`bitbucket`, 3) | **added**: connect, find, show with build checks, create (see Bitbucket) |
| Link previews (`linkPreview`, 1) | **added** (see Link previews) |
| Localhost worktree labels (`localhostWorktreeLabels`, 1) | **added** (see Localhost labels) |
| Remote hosts over SSH and on-demand VMs (`ssh` 22, `ephemeralVm` 11, `runtimeEnvironments` 33) | **started**: SSH hosts, config import, connection test, remote terminal, port forwards, remote file browsing (see SSH hosts); projects, task worktrees, terminals and agent CLIs on the host (see Projects on SSH hosts); files, Source Control (discard, fetch, pull), search, auto-refresh, PRs, base/sparse choice, hook and title agent status, in-app passphrase prompts for host worktrees, and a host worktree as the IDE's open folder (see SSH worktrees); not yet: language servers on the host, VMs |
| Mobile pairing and Android emulator (`mobile` 12, `emulator` 5) | **added**: pairing with QR/code, devices with revoke, phone page with live task status, messages to agents and answers to permission prompts and questions (see Mobile pairing); not yet: Orca's app features, relay, emulator |
| Orca plugins and browser extensions (`plugins` 36, `browserExtensions` 13) | Kingu has Snaps instead |
| Computer use helper app, pet, star-nag | missing (low value) |
| WSL (`wsl*`) | not applicable on macOS |
| Workspace Space (`workspaceSpace`, 9) | **added in this round** |
| Ports, cleanup, vault search, queued follow-ups, notebooks, Linear/Jira/GitLab, automations, usage | present |
