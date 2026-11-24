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
| Terminals | tabs of the floating workspace (no local folder needed), the `ssh -t` command typed into a local shell; agent tabs are followed for status. An agent's tab runs a multi-line `sh -c` loop (ssh options, hook settings, reconnect): its script goes in the shell's environment as `KINGU_TERMINAL_RUN` and the typed line is only `sh -c 'eval "$KINGU_TERMINAL_RUN"'` (same commands and exit code), so no `quote>` line is echoed per script line (`pty.rs run_through_env`, applied in `pty_spawn`) | Kingu, **estimated** (Orca shows remote terminals in the worktree's own panes); the env hand-over follows Orca's `ORCA_POSIX_SHELL_STARTUP_COMMAND` (`src/main/pty/shell-startup/posix-shell-startup-command.ts`), which Orca runs from a prompt hook where Kingu types the short line |
| Remote folder | the worktree opened as the folder you work in: a window-sized view with file tree, editor, diff and Source Control; the last one opened comes back on start when no local folder is open | Kingu, **estimated** (Orca activates a remote repo's worktree like a local one) |

| Discard | per file: tracked → `git restore --worktree` (else `git checkout`), untracked → `git clean -f`; literal pathspecs; asks first ("cannot be undone") | `src/main/git/source-control/mutations/discard-changes.ts:discardChanges` |
| Fetch / Pull | `git fetch -q --prune origin`; `git pull -q` with the host's own pull settings; `GIT_TERMINAL_PROMPT=0`, 120 s | Orca `fetchRemote`, `pullBranch` (`src/main/git/remotes/remote.ts`) |
| Go to File | `git ls-files --cached --others --exclude-standard` (tracked + untracked, not ignored), at most 50 000, picked in the quick picker | Orca `listFiles` (filesystem provider); limit **estimated** |
| Search | `git grep -z -n -I -F [-i] --untracked -e <text>`, binary files skipped, 500 hits, 300 characters a line; a hit opens the file at its line | Orca `search` (filesystem provider, ripgrep on its server); Kingu's `git grep` and limits **estimated** |
| Auto-refresh | no watcher on the host: every 5 s while the window shows and no git action runs, one ssh call returns git status and the open file's `cksum`; a new status re-reads git and the open folders, a new checksum re-reads a file without unsaved edits | Orca's server watches (`watch` in the filesystem provider); Kingu's poll **estimated** |
| Shared connection | background calls use `ControlMaster=auto`, `ControlPath=~/.ssh/kingu-%C`, `ControlPersist=120` (Unix, when `~/.ssh` exists; a socket path must stay under 104 bytes); the connection test and port forwards never share | Kingu, **estimated** (Orca keeps one ssh2 connection per host) |
| Prompts | ssh's passphrase / password / host-key questions reach the app: `SSH_ASKPASS` = Kingu's helper with `SSH_ASKPASS_REQUIRE=force`; the helper makes a FIFO in a 0700 folder, leaves `<id>.req` (host and prompt, no secret), and blocks on the FIFO; Kingu's watcher asks the window (quick input, hidden for secrets), the answer goes `1<value>` / `0` (Cancel) through the FIFO, never to a file; the command's time limit pauses while a prompt is open | `src/main/ipc/ssh/ssh-passphrase.ts` (`ssh:credential-request`, `ssh:submitCredential`), `ssh-connection-handlers.ts` (`ssh:needsPassphrasePrompt`); FIFO helper **estimated** |
| Prompt view | ssh's whole question is shown wrapped above the input (key fingerprints `SHA256:…` / `MD5:…` in monospace), with a short title and placeholder; a host-key question (`(yes/no[/[fingerprint]])?`) is a Yes / No pick: Yes answers `yes`, No and Escape decline like Cancel (`sshCredential.ts`, the quick input's `title` / `message`) | Orca's `SshPassphraseDialog.tsx` (`src/renderer/src/components/ssh-authentication/`) shows the request's detail wrapped (`whitespace-pre-wrap break-words`) above the input. Orca never asks about host keys: its ssh library trusts an unknown host on first contact and remembers it (`accept-and-remember`, `src/main/ssh/host-keys/ssh-host-key-decision.ts`); Kingu runs the system ssh and keeps ssh's own question (deliberate difference) |
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

## SSH connection lifecycle and held terminals (added 2026-11-22/23)

Read from Orca's source (`/Users/bright/src-ref/orca` at 3b2f28b30, release 1.4.269). Nothing in
this section was exercised against a real host: the tests run the scripts with `sh`, a stand-in
`ssh` on `PATH`, and the real `kingu-ptyd` on this computer.

Kingu: `src-tauri/src/ssh_hosts.rs` (`connect`, `keepalive`, `ssh_connect`, `ssh_keepalive`,
`ssh_disconnect`, `ssh_forwards_restart`), `ssh_holder.rs` (holder delivery, handshake, pruning,
terminal loop, remote permission answers), `ssh_host_hooks.rs` (remote status hooks, their
removal), `ssh_projects.rs` (`terminal_run`),
`crates/kingu-ptyd/src/attach.rs`, `tools/build-ptyd-host.ts`; `src/lib/ade/sshConnection.ts` +
`sshConnections.svelte.ts` (states, ladder), `sshHolder.ts` + `sshHolders.svelte.ts`,
`sshProjects.svelte.ts`, `SshProjectsSection.svelte`. Setting `kingu.ssh.terminalHost` (default
on). Palette: **SSH: Reattach Terminal on Host…**.

### Connection

| Rule | Value | Orca source |
|---|---|---|
| States | disconnected, connecting, auth-failed, connected, reconnecting, reconnection-failed, error (no `deploying-relay`: Orca's type still has it but nothing sets it; setup shows as `connecting` plus a phase) | `src/shared/remote-runtime/ssh/ssh-types.ts`, `src/main/ipc/ssh/ssh-connection-state-callbacks.ts` |
| A dial | `echo KINGU-SSH-OK` over the shared connection must exit 0 with its mark; `ConnectTimeout=30`, the whole dial 35 s (was 10 s / 15 s) | `CONNECT_TIMEOUT_MS = 30_000`, `src/main/ssh/connection/ssh-connection-timing.ts`; `ssh-system-ssh-probe.ts` |
| First connect | up to 5 dials 2 s apart for errno-shaped failures; a sign-in failure ends as auth-failed | `INITIAL_RETRY_ATTEMPTS`, `INITIAL_RETRY_DELAY_MS`, `reconnect/ssh-reconnect-error-classification.ts` |
| Keepalive | every 15 s a connected host is asked again and has 15 s to answer (`ssh_keepalive`; the dial's 30 s would delay noticing a drop); the shared connection sends `ServerAliveInterval=15`, `ServerAliveCountMax=3` | `keepaliveInterval: 15_000` (`ssh-connect-config.ts`), `system-transport/system-ssh-args.ts` |
| Reconnect ladder | waits 1, 2, 5, 5, 10, 10, 10, 30, 30 s; nine failed dials → reconnection-failed; 60 s connected restarts the ladder; a flapping host is capped at 5 s; the network returning restarts a spent ladder | `RECONNECT_BACKOFF_MS`, `STABLE_CONNECTION_MS`, `FLAP_DELAY_CAP_MS`, `reconnect/ssh-reconnect-ladder.ts` |
| Disconnect | `ssh -O exit` on the shared connection; no redial until Connect | `ssh-user-disconnect.ts` |
| Port forwards after a reconnect | every forward of the host is ended and started again on its ports (each is its own `ssh -N -L`, now with the same keepalives so one to a dead host ends); one that can't start is said and stays in Restore | `restoreManagedHostPortForwards` on each transition to `connected`, `ssh-port-forward-persistence.ts:restorePortForwards` |

### The terminal holder

Orca installs a server (`orcad`) on the host, which drives a terminal daemon there; a pane
reattaches with a serialized snapshot of its screen. Kingu's holder is `kingu-ptyd`, the daemon
that keeps local terminals alive after the app quits, used from a plain terminal.

| Rule | Kingu | Orca source |
|---|---|---|
| Platforms | `uname -sm` → Linux x86_64 / aarch64 (one static musl binary each, for glibc and musl hosts), macOS arm64 / x86_64. Anything else: no holder | `SERVER_TARGETS` (`src/shared/node-runtime/node-runtime-pin.ts`: also Windows and glibc/musl variants, because it ships Node and native add-ons), `ssh-remote-platform-detection.ts` |
| What ships | `host-bin/kingu-ptyd-<triple>` in the app's resources, built by `bun run build:ptyd-host` (`cargo zigbuild` for Linux from macOS). For this computer's own platform the app's own daemon binary serves when no file is shipped | `orcad-artifacts.ts` (a Node bundle, a pinned Node, node-pty prebuilds, ripgrep) |
| Upload | piped on ssh's stdin (`cat > …`) | SFTP, else exec stdin (`remote-install-transfers.ts`) |
| Where | `~/.kingu/host/kingu-ptyd-<version>-<first 16 hex of the binary's SHA-256>/kingu-ptyd`, marked by `.install-complete`; sockets and log in `~/.kingu/host/run` (0700) | `~/.orca-remote/orcad-<version>+<digest>`, `.install-complete` (`remote-install-model.ts`, `orcad-remote-install.ts`); build hash = 16 hex of sha256 (`orcad-build-identity.ts`) |
| Integrity | the host checks the byte count, then SHA-256 with `sha256sum`, `shasum` or `openssl` (none of them: the size alone), then runs `host-info`; only then is the folder moved into place. Exit 21 incomplete, 22 checksum, 23 cannot run (a `noexec` home, a wrong platform) | Orca hashes its Node binary, not the bundle (`orcad-remote-node-runtime.ts`) |
| Handshake | ready when that folder's `kingu-ptyd host-info` names `kingu-ptyd` and a protocol the app's daemon code still speaks. The folder name carries the digest, so another app version installs beside it and replaces nothing | `orcad-active.json`, `orcad-update-plan.ts` (new version beside the old one; live terminals survive the switch) |
| Old folders (2026-11-23) | once this app's folder is in use on a connection, every other complete folder of the same or an older version is removed when no process's command line names `/<folder>/kingu-ptyd` (its daemon holding sessions, or a terminal attached through it); never the folder in use, never a newer version's (another computer's newer Kingu), never one whose version can't be read, never one whose install didn't finish; without a process list (`ps -A -ww -o args=`, else busybox `ps -o args`) nothing goes; a folder is renamed to `.gc-…` and then deleted. Kept folders are tried again on the next connection (`ssh_holder_prune`) | `gcOldOrcadVersions` (`src/main/managed-server/install/orcad-remote-gc.ts`, `remote-install-gc.ts`: pins active, rollback and live-daemon versions, idle and unlocked only, tombstone rename), run after an activation by `pruneManagedOrcadVersions` (`lifecycle/orcad-managed-version-gc.ts`; "later connects retry") |
| Consent (2026-11-23) | nothing is installed until the user allows it for that host. On connect the host is only probed; a host without the holder shows "No terminal host" with **Install terminal host…**, and the first terminal or agent started there asks: **Install** / **Not now** / **Never for this host**. Install and Never are kept per host (localStorage `kingu.ssh.holderConsent`); Not now (or dismissing) lasts until Kingu restarts. SSH: Hosts… shows each host's answer with Allow / Never / Ask again. Allowed: later versions install without asking. Never: no holder is used there, not even one already installed. A host that already has this build's holder and no answer uses it (nothing is installed). Until allowed the host uses the plain-ssh restart fallback | Orca does not ask: an empty host gets `orcad` as part of connecting (`deps.deploy`, `src/main/ssh/host-server/ssh-host-server-on-connect.ts`; "Orca installs itself on an empty SSH host and keeps itself up to date", `settings/runtime-environments/managed-servers/runtime-install-server-dialog.tsx`). Kingu's ask-first is a deliberate difference |
| When | on every transition to `connected` (and before a terminal): probe; install only on an allowed host, said once (`Installed Kingu's terminal host on …`) | during connect (`managedServer { kind: 'setting-up' }`) |
| When it can't be had | setting off, unsupported platform, binary not in this build, install failed, not allowed (yet) on that host: the header says "No terminal host" with the reason, and terminals run under plain `ssh -t` | host marked unserved, "Plain SSH terminal" without persistence (`ssh-host-unserved-status.ts`) |

### A held terminal

| Rule | Kingu | Orca source |
|---|---|---|
| Start | the tab runs `ssh -t <dest> kingu-ptyd attach --dir ~/.kingu/host/run --key ssh:<random> --cwd <folder> [--env KINGU_AGENT_HOOK_FILE=…] --idle-seconds 900 -- <agent argv>`: the daemon (started on demand, in a session of its own) opens a login shell in the folder and types the agent command once | PTYs live in the host's terminal daemon (`src/main/daemon`), ids `<worktree>…<uuid8>` |
| The terminal's ssh | its own connection, `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `ConnectTimeout=30`; a dead peer ends it within 45 s with exit 255 | `system-ssh-args.ts` |
| A drop | the tab's loop (`ssh_holder.rs` `loop_script`, run by local `sh`) says so, waits until `ssh -O check` on the shared connection succeeds (the connection the ladder redials; every 2 s, no limit, Ctrl+C stops it), then runs `attach --key <same>` | "This terminal will resume after the host is available." (`TerminalSshReconnectOverlay.tsx`); `terminal.recoverPane` |
| Replay | the session's scrollback ring, the last 256 KB of raw output, then live output; the terminal's size is sent on attach and on change (polled every 200 ms) | a headless-xterm serialized snapshot, at most 2 MiB, 1000 scrollback rows (`daemon/emulation/headless-emulator.ts`) |
| Session ended meanwhile | `attach` exits 3 and the tab says the terminal ended on the host | `terminal_exited` / `terminal_gone` retire the pane |
| Give up | three ssh failures in a row, each within 5 s of starting, stop the loop (the host refuses the terminal while its shared connection answers) | Kingu, **estimated** |
| Lifetime | a session lives until its shell exits or its tab is closed (`kingu-ptyd end`); the daemon exits 15 minutes after its last session and client | `ORCAD_IDLE_EXIT_TIMEOUT_MS = 15 * 60_000`, blocked while terminals exist |
| After Kingu restarts | (2026-11-23) the first time each host connects, the live sessions this computer started there (remembered in localStorage with name, folder and hook file) whose tabs aren't open are opened again in tabs and reattached, by the first window (`main`) only so two windows never show one session twice; said in the status bar. **SSH: Reattach Terminal on Host…** still lists every held session, those started elsewhere too | panes reattach in their old tabs (`src/renderer/src/store/terminals/hydration/terminal-session-row-hydration.ts` `reconnectPtyIdByRetainedTabId`) |
| Without a holder | an agent runs under `ssh -t` as before; after a drop the loop starts it again with its CLI's resume command (`claude --continue`, agentProfiles.ts `cliResume`) and says it is a new process, not the terminal that was lost; a CLI that can't resume, and a plain shell, just end | none (Orca's plain SSH terminal has no persistence) |

### Agent status and permission answers from a host

| Rule | Kingu | Orca source |
|---|---|---|
| Hook file | every agent session on a host gets `KINGU_AGENT_HOOK_FILE=~/.kingu/agent-hooks/<token>.jsonl`, read over ssh every 2 s while the host is connected | hooks post to a server inside `orcad` on the host (`ORCA_AGENT_HOOK_PORT/TOKEN/ENDPOINT`, `orcad-managed-agent-hooks.ts`) |
| claude | per-session `--settings` hooks append to that file; PermissionRequest runs `~/.kingu/host/permission-hold.sh` (the local hold script, written there once per connection) and waits up to 122 s | `CLAUDE_PERMISSION_HOLD_BUDGET_MS = 122_000` |
| Answering | the side bar shows the request under the worktree (tool, detail, a deny reason field, Allow / Allow for this session / Deny; the reason is one line of at most 500 characters, as on the local card, `permissionAsk.ts` `denyMessage`); the answer is written to `<token>.<hold>.answer` on the host through ssh's stdin, only while `<token>.<hold>.wait` exists; a session grant is checked against the request line read back from the host | `orchestration.approvalAnswer` (`worker-approval-answer.ts`) |
| Other CLIs | before gemini, cursor, copilot, droid, codex, qoder, qwen, codebuddy, openclaude, grok, devin, command-code or antigravity starts on a host (with `kingu.agent.statusHooks` on), its config under the host's `$HOME` is read, merged on this computer by the local rules (`status_hooks::apply`), and written back (the old file kept as `<file>.kingu.bak`); the script is `~/.kingu/host/agent-status/agent-hook.sh` (`ssh_host_hooks.rs`) | managed hooks installed on the host by its server (`startOrcadManagedAgentHooks`, `src/main/orcad/host-runtime/orcad-managed-agent-hooks.ts`) |
| codex (2026-11-23) | `~/.codex/hooks.json` gets the entries; `~/.codex/config.toml` gets a `[hooks.state."<host home>/.codex/hooks.json:<event>:<group>:0"]` table per Kingu group with `trusted_hash` (the local hash, `status_hooks::codex_hash`); the TOML is checked before hooks.json is written, and one that doesn't parse stops both | `installCodexHooksRemote` (`src/main/codex/hooks/installation/codex-hook-remote-install.ts`): `sourcePath: remoteConfigPath`, not a resolved path |
| opencode (2026-11-23) | no user config is edited: the plugin is written to `~/.kingu/host/agent-status/opencode/plugins/kingu-agent-status.js`, the folder the host's own `OPENCODE_CONFIG_DIR` names (as ssh's non-interactive shell sees it) is mirrored in with links, and the agent starts as `env OPENCODE_CONFIG_DIR=<that folder> opencode …` (its resume command too) | an overlay `OPENCODE_CONFIG_DIR` per session (`src/main/opencode/status-hooks/hook-service.ts`), refreshed on the host by `refreshInstalledOpenCodeStatusPlugins` |
| Turning the setting off (2026-11-23) | each file Kingu wrote on a host is remembered on this computer with the SHA-256 of what was written (`<app data>/ssh-host-hooks.json`). When `kingu.agent.statusHooks` goes off, every connected host with records (and any other at its next connection) is cleaned: a file still exactly as Kingu wrote it, whose `.kingu.bak` has none of Kingu's entries, gets the backup back (checked again on the host just before the move); otherwise only Kingu's entries are taken out and the user's later edits stay; a file of Kingu's own (copilot's, grok's) that is left empty is deleted; codex's config.toml goes before its hooks.json. Then `~/.kingu/host/agent-status` (script, opencode overlay) is removed. A file that can't be changed stays on record and is said | Orca strips its entries when the setting goes off, on the host by its server's reconcile (`removeManagedHooks`, `src/main/claude/hooks/hook-settings.ts`; codex `src/main/codex/hooks/installation/codex-hook-off-strip.ts`); its remote writes keep no backup (`hooks-json-remote.ts`). Putting the `.kingu.bak` back is Kingu's own rule |

### Answering a host's agent from the side bar (added 2026-11-23)

Orca (3b2f28b30) gets a remote agent's hook events over the SSH channel (its relay forwards them to
the desktop's hook server, `src/main/agent-hooks/server/server-ingest-remote.ts`,
`server-relay-sessions.ts`) and answers the prompt the same two ways it answers a local one. Kingu
has no relay: the hook file and the hold files live on the host and are read and written over the
host's shared ssh connection; keys go into the tab's `ssh -t`. The card's state is
`src/lib/ade/sshAsks.ts` `remoteAsk`; the card is `SshProjectsSection.svelte`; the answers are
`sshProjects.svelte.ts` `answer` / `answerQuestion`; Rust is `ssh_holder.rs`
`ssh_remote_permission_answer`.

| Rule | Kingu | Orca source |
|---|---|---|
| Held permission prompt | a claude waiting in `permission-hold.sh` on the host: Allow, Allow for this session, Always allow in this project, Always allow, Deny with a reason; the reply is Claude's own PermissionRequest decision written to `<token>.<hold>.answer` there | `claudePermissionReply` (`src/main/agent-hooks/server/claude-permission-hook-hold.ts`) |
| Wider scopes | session grants are Claude's suggestions with `destination: "session"`; the two "Always" buttons send only its suggested allow rules with `localSettings` / `userSettings` (permission_rules.rs `scoped_grants`, the local card's rules), checked against the request line read back from the host. The claude on the host saves them itself, so they are not in this computer's Permission Grants list; the button's tooltip names the file there | `allowForSession` (`src/main/claude/structured/journal/claude-structured-prompt-replies.ts`); VS Code `generateAutoApproveActions` for the scopes, as on the local card |
| No hold | another CLI's prompt, or a claude without the hold script: Allow presses Enter (its first choice) and Deny Esc in the agent's terminal; never a grant | Orca types approvals into the remote pane's PTY (`use-native-chat-interactive-send.ts` `sendRaw`) |
| Questions | a question whose hook carried its options (AskUserQuestion, codex `request_user_input`, …) gets the question card in the side bar; the answer is the CLI's own keys (`ask.ts` `askKeysFor`, one step per second), typed only while the host is connected and the tab is open | "Reuse composer routing to the live local/remote PTY; selector agents receive keystrokes" (`src/renderer/src/components/native-chat/session/terminal/send/use-native-chat-interactive-send.ts`) |
| Question without options | Show terminal | — |
| Timeout | the hold waits 122 s, then prints `{}`: no decision, so claude asks in its own terminal. The card then says Expired with Show terminal and nothing to press; an answer that finds the hold gone (`none`) marks it expired too and is never retried or sent as keys | `CLAUDE_PERMISSION_HOLD_BUDGET_MS = 122_000`; a hold that ends by budget, hang-up or quit answers `{}` (`ClaudePermissionHoldEnd`) |
| Disconnect mid-question | while the host is not connected every prompt of its agents shows Expired (the connection dropped, nothing allowed) and nothing can be pressed: no ssh answer and no keys into the reconnect loop. The hold on the host keeps waiting by itself, so a prompt still inside its 122 s is answerable again after the reconnect; past it, it is the timeout above | Orca's hold ends with `{}` when the hook hangs up (`hook-gone`) |
| Never auto-allow | nothing in Kingu answers a prompt without a press; every path that ends without one leaves Claude's own prompt in its terminal | Orca never writes an allow it was not given (`claudePermissionReply(null)` is `{}`) |
| After an answer | the card goes at once (the hook state is set to working / idle until the next event, as the local card does) and its buttons wait while the answer is in flight | — |

What still needs a real host: the latency of an answer over the shared connection, a hold timing
out on the host while its connection is up, and claude's own terminal prompt after `{}`.

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
| Answers | `POST /api/answer` `{root, slug, answer: allow \| deny \| question, selections}`: refused (409) unless that task's live row shows that very prompt open. Allow types Enter (the CLI's highlighted first choice, "Yes"/"Allow once"), Deny types Esc; a question goes through the desktop quick reply's keystrokes (`cliSessions.answer`, Orca's `buildAskAnswerKeys`). A claude Kingu started takes allow / deny in its waiting hook instead; then `allow_session` with `grants` (exactly the live row's `request.grants`, else 409) allows for the CLI session, and `deny` may carry a `message` (500 characters) for the agent |
| Phone page language | Kingu's language (Rust catalog `MobileWebMsg`) |

Not built: Orca's native app features (terminals, diffs, git actions, creating worktrees,
push notifications), the relay for use outside the local network,
end-to-end encryption, Windows firewall repair, the Android emulator (`emulator`).

## Needs you / Inbox across every agent (added 2026-11-24)

Orca 1.4.272's mobile "Needs you" (release notes; `/Users/bright/src-ref/orca` at 7ebb8cfbd)
next to VS Code 1.146's Inbox mode (docs/IDE-PARITY.md §17 has the VS Code side). Kingu's page:
`src/lib/ade/InboxPage.svelte`, store `sessionInbox.svelte.ts`, rules `sessionInbox.ts`; shown
when `sessions.list.inboxEnabled` is on.

What Orca does:

| Mechanism | Orca | Source |
|---|---|---|
| What counts | a bot's chats and workers waiting on the owner, connectors needing a sign-in, access requests, paired servers' agents waiting to message it; a run a sign-in stopped is listed but not counted | `mobile/src/bots/items/phone-needs-you-asks.ts` `phoneNeedsYouAsks`, `phoneAskCounts` |
| Count | asks + items set to Needs you | `src/shared/bots/bot-now.ts` `botNeedsYouCount` |
| Order | approvals first, then the rest in the tree's order (needs-you first, then newest) | `phoneNeedsYouAsks` |
| Fold | approvals never hidden; then five rows (`NEEDS_YOU_CAP`); a "Show N more" footer only when it would hide two or more; the row holding keyboard focus stays | `src/shared/bots/needs-you-fold.ts` `needsYouFold` |
| A tap | opens where the ask was made (the chat, the worker, the access request); a row the phone can't reach is dimmed and says so | `mobile/src/bots/items/MobileBotNeedsYouGroup.tsx` |
| Filter | "Needs you only" on the Items tab | `mobile/src/bots/MobileBotPanelHeader.tsx` |

What Kingu does:

| Mechanism | Kingu | Kingu source |
|---|---|---|
| What counts | every agent Kingu already watches, from the stores the status dots, permission cards and SSH asks use: the open folder's tasks (`adeTasks.views`: the task CLI's hooks, its other terminal panes, its agent-host run), every other added project's tasks (`projects.all`), chats of every folder (`chats.runs`, only runs of this app session), agent CLIs in SSH terminals (`sshProjects.agents` judged by `remoteAgentStatus`, the hook's permission / question) | `sessionInbox.svelte.ts` `entries` |
| Needs | approval, question, failed, ready to review (a finished turn), working (its own section) | `sessionInbox.ts` `InboxNeed`, `taskNeed`, `chatNeed` |
| Order | VS Code's priority (approval and question, then failed, then review), newest first within | `priorityOf`, `buildInbox` |
| Fold | Orca's rule exactly | `foldInbox` |
| A click | opens the task (switching project when needed), the chat (this folder's), or the SSH agent's terminal tab; another folder's chat says which folder to open | `SessionInbox.open` |
| Triage | VS Code's (dismiss, hold, snooze, return, undo); Orca's phone has none | `isTriageCurrent`, `snoozeChoices` |
| **Kingu only:** answer from the row | Allow (once) / Deny for a chat's or an agent-host task's own permission prompt, through the same `agent_answer_permission` call as the chat card. Not for questions, "always" grants, a CLI's terminal prompt or an SSH hold: those open where they were asked, so their fuller cards stay the place to decide | `InboxEntry.answer`, `SessionInbox.answer` |

Not built: plain terminals of the root folder (no task), connectors and access requests (Kingu has
no bots), a mobile view of the Inbox (the phone page lists tasks with their live state, above).

Scheduled agent runs (VS Code 1.145 cron schedules, `chat.automations.enabled`, the catch-up
rule when Kingu was closed) are in docs/IDE-PARITY.md §17; Orca's automations are what Kingu's
earlier schedule text follows (`ade/schedule.ts`).

## Agent CLIs Kingu installs itself (added 2026-11-22/23)

Read from Orca's source (`/Users/bright/src-ref/orca` at 3b2f28b30, release 1.4.269):
`main/managed-agent-cli/managed-agent-cli-registry.ts`, `main/node-runtime/*`,
`main/<agent>/*-managed-runtime.ts`, `main/acp/registry/*`,
`main/runtime/rpc/methods/host-management/managed-runtime-install.ts`,
`renderer/src/components/native-chat/host-access/NativeChatInstall{Hero,Strip,Slot}.tsx`,
`renderer/src/components/managed-runtime/*`. On an SSH host, see "Agent CLIs Kingu installs on
an SSH host" below.

Kingu: `src-tauri/src/agent/managed_cli/` (`mod.rs` service and commands `managed_cli_list`,
`_status`, `_install`, `_cancel`, `_remove`; `pin.rs` lookups; `fetch.rs` network; `archive.rs`
unpacking; `release.rs` staging, receipt, start check), `agent/runtimes.rs` (`locate_known`),
`agent/cli.rs`, `agent/host.rs` (`stop_agent`); `src/lib/agent/managedCli.ts` (cards),
`managedCli.svelte.ts`, `ManagedInstallCard.svelte` (empty chat), `ManagedInstallStrip.svelte`
(started chat), `ManagedCliRow.svelte` (Settings › Agents). Event `managed-cli:changed`.

### Sources

| Agent | Where the latest release and its digest come from | Form | Command in the release |
|---|---|---|---|
| OpenCode, OpenCode 2, Cursor | the ACP Registry (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, ids `opencode`, `opencode-v2`, `cursor`); the listing's sha256, else `<archive>.sha256` beside it (Cursor lists none) | tar.gz / zip by the URL's ending (macOS: OpenCode zip, Cursor tar.gz) | the listing's `cmd` must equal Kingu's fixed path: `opencode`, `dist-package/cursor-agent` (`.cmd` on Windows); otherwise that release is not offered |
| GitHub Copilot | GitHub's latest release of `github/copilot-cli`, `SHA256SUMS.txt`; GitHub's own asset digest must agree | `copilot-<darwin\|linux\|linuxmusl\|win32>-<arm64\|x64>.tar.gz` (Windows zip) | `copilot` |
| OMP | latest release of `can1357/oh-my-pi`, `SHA256SUMS.txt` | the bare program `omp-<os>-<arch>` | `bin/omp`, plus `manager.json` `{"name":"Kingu"}` so it leaves updates to Kingu |
| Grok | npm `@xai-official/grok` `latest`, then the platform package's `dist.tarball` and its sha512 `integrity` | npm tarball; the program is `package/bin/grok.br` (brotli) | `bin/grok`, decompressed (bounded) from the `.br` |
| Kimi Code | `code.kimi.com/kimi-code/latest`, then `binaries/<v>/manifest.json` `checksum` (sha256) | the bare program; no musl build | `kimi` |
| Antigravity `agy` | Google's updater manifest `<platform>.json` (`version`, `url` under `storage.googleapis.com/antigravity-public/antigravity-cli/`, `sha512`) | tar.gz (Windows: the bare `.exe`) | `antigravity` in the archive, renamed `agy` |

No version or checksum is fixed in the code (Orca fixes none for these). A lookup is reused for an
hour; a release below the launch floor (`runtimes::min_versions`) or without a published digest
is never a pin.

### Download, digest, staging, receipt

| Rule | Kingu | Orca source |
|---|---|---|
| Asked first | nothing is looked up or downloaded until a card or Settings row shows (lookup only) and the user presses Install | Install in the hero / strip / Settings |
| Transport | HTTPS only, redirects followed only to https (at most 10), the user's `http.proxy` settings | `runtime-archive-download.ts` |
| Size | the published size (asset size, `Content-Length`, or a 1-byte range request) is shown first and is the most ever read; a larger body is refused | `runtime-download-size.ts` |
| Digest | sha256 or sha512 computed while writing; the file (0600, never executable) is deleted unless it matches; nothing is unpacked, made executable or run before | `downloadVerifiedArchive` |
| Stall / cancel | no bytes for 120 s ends the attempt; a Cancel ends it within a fraction of a second. The body is read by an async task that is aborted when the download returns, so the connection closes at once (tested against a local server that stalls) | stall timer, `AbortSignal` |
| Retries | network failures retried after 1, 3, 9 s; a mismatch or 404 never | `RUNTIME_ARCHIVE_RETRY_DELAYS_MS` |
| Deadline | 45 minutes for the whole install | `DEADLINE_MS` |
| Disk | needs the download × 4 (a bare program × 1) + 256 MB free; unpacking stops at the download × 40 + 256 MB | `FREE_SPACE_MARGIN_BYTES`, `UNPACKED_RATIO` |
| Unpacking | in-process; an entry or link leaving the folder, a device or fifo, a hard link through a link or to a folder, or a damaged archive refuses the whole download; pax keys other than `path`, `linkpath`, `size` are skipped (Cursor's carry binary code-signature xattrs) | the system `tar` / `unzip` |
| Staging | `<app data>/agent-runtimes/<agent>/.download-<pid>-<n>/`; removed on any failure | same layout under `<userData>/agent-runtimes` |
| Start check | `<command> --version` (60 s; agy with `AGY_CLI_DISABLE_AUTO_UPDATE=true`) must answer the release's version (the registry's date version may carry a `-<hash>` suffix) | `requireRuntimeAnswersVersion` |
| Receipt | `.install-complete.json`: `releaseId` (the digest), version, platform, arch, and each command with its size; written before the folder is renamed to `<version>/`, so a published release is always whole | `managed-runtime-release.ts` |
| Damaged | a folder whose receipt or members do not match is not used; Install repairs it | `resolveInstalledRuntimeRelease` |
| Reclaim | at start, and after an install: the release launches use and the one running chats may still use stay; the rest and stale staging go | `reclaimRuntimeReleases` |

### Lookup order and use

| Rule | Kingu | Orca source |
|---|---|---|
| A chat's launch | PATH, then the agent's installer folders, then Kingu's copy (`locate_known`); the user's own install always wins | `resolveAcpLaunchCommand` |
| Pickers | an installed copy counts as installed for the chat's and the CLI pickers (`managed_cli::provides`) | `provideManagedAgentDetection` |
| Terminals | Kingu's release folders go last on a terminal's PATH | `appendManagedAgentDirsToChildPath` |
| Chat without the agent | an empty chat shows the install card (size, host, the checksum promise); a started chat shows a one-line strip above the composer ("Install {agent} to continue", Install / progress / Cancel); sends wait until it is installed, then the chat resumes its session | `NativeChatInstallHero`, `NativeChatInstallStrip`, `useNativeChatInstallSlot` |
| Remove | asks first ("chats that are running stop; history is kept"); stops every live chat of that agent and waits up to 10 s for each to end, else refuses ("Not every … chat could be stopped") and deletes nothing; then deletes `agent-runtimes/<agent>` only | `ManagedRuntimeRemoveDialog`, `stopStructuredAgentChats` fence |
| Install vs remove | an install while removing, or a remove while installing, is refused; a remove cannot be cancelled | `ManagedRuntimeInstallation.install/remove/cancel` |

### Auto-update

| Rule | Kingu | Orca source |
|---|---|---|
| When | 2 minutes after start for every installed copy, and when a launch resolves to Kingu's copy (at most every 10 minutes per agent) | `AUTO_UPDATE_FIRST_CHECK_MS`, `AUTO_UPDATE_USE_THROTTLE_MS` |
| What | only Kingu's own copy, only when it is what runs (not when the user's own install wins), only to the publisher's latest release; one attempt per release per hour | `updateIfBehind`, `AUTO_UPDATE_RETRY_MS` |
| Never | installs a copy nobody asked for | — |
| `kingu.agent.antigravityManagedAgy` (default on) | off: Kingu's `agy` runs no chat, counts as not installed, is neither installed nor updated; its folder stays on a terminal's PATH | `antigravityManagedAgyEnabled` (`managedCopyAllowed`, `managedCopyMayRun`) |

Checked live on macOS arm64 (2026-11-23): the eight lookups answer and their file names match
the table; OpenCode 2.3.2 (zip, 109 MB) and Cursor 2026.11.22 (tar.gz, 175 MB) were downloaded,
verified, unpacked and prepared through this code into a scratch folder (the start check stubbed,
nothing run), the Cursor tree identical to the archive's listing (441 entries, modes kept); both
then deleted. The Copilot, OMP, Grok, Kimi and agy archives were not downloaded today; their
layouts rest on the listings above, Copilot's own `install.sh` (`copilot` at the archive's
root) and Orca's code.

### Antigravity: Kingu's ACP server and Google sign-in (added 2026-11-23)

Read from Orca's source: `main/antigravity/antigravity-acp-runtime.ts` (the pin),
`antigravity-acp-runtime-probe.ts` (start check), `antigravity-acp-launch-spec.ts` (managed and
host launch specs), `antigravity-chat-route.ts` (which program a chat runs), `antigravity-host-acp.ts`
(`agyUsesApiKey`), `agy-credential-presence.ts`, `antigravity-acp-environment.ts` and
`antigravity-acp-environment-sanitizer.ts`, `antigravity-browser-helper.ts`,
`antigravity-sign-in-url.ts`, `antigravity-chat-sign-in.ts`, `antigravity-chat-account.ts`,
`main/acp/acp-dialects/antigravity-dialect.ts`, `main/acp/launch/acp-session-meta.ts`,
`shared/agent-session/lifecycle/launch/agent-session-setup-commands.ts` (agy's terminal login),
`shared/settings/host-owned-settings.ts` (`antigravityGoogleSignIn`), and the renderer's
`components/provider-accounts/AntigravityChatSignInAction.tsx`,
`components/native-chat/antigravity-auth/*`.

Kingu: `src-tauri/src/agent/antigravity.rs` (route, server env, chat home, command
`antigravity_chat_route`), `managed_cli/pin.rs` (`AgyAcpServer`), `managed_cli/release.rs`
(`verify_members`), `managed_cli/acp_probe.rs`, `agent/runtimes.rs` (`resolve`, `available`,
`launch_env_for`), `agent/mod.rs` (`agent_sign_in`), `agent/events.rs` (`SignIn`);
`apps/agent-host/src/runtimes/acpSignIn.ts`, `acpDialects.ts` (`agy`, `agy_acp_server`),
`acp.ts` (the sign-in wait), `session.ts` (`outputLine`); `src/lib/agent/agentSignIn.ts`,
`AgentSignInCard.svelte`, `events.ts` (`sign_in`), `managedCli.ts` (`SERVES`, `installFor`),
`settings/pages/AgentCatalog.svelte` (the server's row under Antigravity).

| Rule | Kingu | Orca source |
|---|---|---|
| Two programs | `agy acp` (the user's own, or Kingu's copy of agy) with agy's own sign-in in `~/.gemini`; or Kingu's managed ACP server `agy_acp_server` (managed_cli id `antigravity-server`, folder `agent-runtimes/antigravity`) with its own sign-in in `<app data>/antigravity-chat` | `ANTIGRAVITY_HOST_LAUNCH_SPEC`, `ANTIGRAVITY_MANAGED_LAUNCH_SPEC` |
| Route | `kingu.agent.antigravityGoogleSignIn` `kingu`, or agy's `settings.json` naming a `modelProvider` (unreadable JSON counts): the server. `agy`: agy. `auto` (default): agy, unless Kingu's server is installed or Kingu's agy is turned off — then a found, signed-in agy (its token file, keyring marker, or the macOS Keychain item's attributes, never its secret) still takes new chats, else the server. Orca's ACP readiness probe of agy is not run: a login present counts as signed in | `computeAntigravityChatRoute`, `agyCredentialPresence`, `agyUsesApiKey` |
| Install follows the route | `antigravity_chat_route` says what the chat's Install adds (`antigravity` or `antigravity-server`); a chat routed to the server shows the server's install card even where agy is found; the server is never a picker row of its own | `installs: 'server' \| 'agy'`, `installsManagedRuntime` |
| The pin | version 1.5.2 from `dl.google.com/agy-extensions/releases/<os>/agy-acp-server-1.5.2-<os>-<arch>.zip` for darwin arm64/x64, linux x64/arm64, win32 x64/arm64: the archive's sha256 and size, then `agy_acp_server.par` (`.exe`) and `localharness_external` each checked for Orca's sha256 and size before anything runs (`verify_members`) | `PINNED`, `members` |
| Start check | no `--version`: ACP `initialize` from a throwaway folder that is also `GEMINI_HOME`/`TMPDIR` (90 s); must answer `agentInfo` `antigravity-acp` 1.5.2, protocol 1, `loadSession`, session `resume`, `auth.logout`, and auth method `oauth-personal`; killed afterwards | `probeAntigravityAcpServer`, `isPinnedServer` |
| Server launch | args `--uid=` on Linux; env `AGY_ACP_FORCE_FILE_STORAGE=1`, `PYTHONUNBUFFERED=1`, `GEMINI_HOME=<app data>/antigravity-chat`, `BROWSER` = the link helper (Unix); never inherited: `GEMINI_API_KEY`, `GOOGLE_*`, `AGY_ACP_*` (but its own), `ANTIGRAVITY_HARNESS_PATH`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`, `CHROME_CRASHPAD_PIPE_NAME`; `antigravity-acp/settings.json` written `{"auth":{"type":"oauth-personal"}}` (0600) when it differs | `ANTIGRAVITY_ACP_ENV`, `scrubAntigravityAcpEnvironment`, `antigravityChatAccount.prepare` |
| Session `_meta` | `{"antigravity":{"disabledTools":["run_workflow"]}}` on `session/new`/`load`/`resume` and the model probe, so the server writes no `skills/system/run-workflow` into the chat's folder | `sessionMeta` |
| Modes and commands | server: ask `default`, accept edits `auto_edit`, allow all `yolo`; agy: `default`, `accept-edits`, allow all = `default` (Kingu answers its prompts); `/logout` withheld from both (it would sign every Antigravity chat out) | `permissionModeConfig`, `withheldCommands` |
| Signed out | the ACP `-32000` "auth required" on opening a session no longer ends the run for these two: a `sign_in` event (`required`) puts a card above the composer — "Sign in to Antigravity", Kingu never sees the password or token — and the run waits for the chat's Sign in or Stop. Other agents keep "Sign in to <agent> in a terminal first" | `NativeChatAntigravityAuth`, `AntigravityChatSignInAction` |
| Google sign-in (server) | Sign in with Google sends ACP `authenticate` `{methodId: "oauth-personal"}` (5 min); the server runs Google's OAuth with its own loopback listener. The link it would open is read from its line `Open the following link to authenticate the ACP server: <url>` or from the `BROWSER` helper (`/bin/sh -c 'echo "__KINGU_ANTIGRAVITY_AUTH_URL__$1" >&2'`), shown only if it is `https://accounts.google.com/o/oauth2/v2/auth` with one `response_type=code`, one `state` and a `redirect_uri` of `http://127.0.0.1:<1024-65535>/`; the line never appears as agent output. The card offers Open sign-in page (through the trusted-domains check) and Copy link; a failure shows why with Try again; success opens the session again | `startAntigravityChatSignIn`, `antigravitySignInUrl`, `readAntigravitySignInLine`, browser helper |
| agy sign-in | Sign in in a terminal types `env AGY_CLI_DISABLE_AUTO_UPDATE=true agy` into a new Kingu terminal (agy's own login); I've signed in asks agy again, and says so if it is still signed out | `systemLoginCommand: ['agy']`, `loginEnv` |

Not built: Gemini Enterprise with a Google Cloud project, its sign-in flow in a separate server
process with a credential swap, pasting a remote browser's callback, the agy readiness probe and
its cache, the Windows `BROWSER` helper (Windows reads only the printed line, and Python may open
the browser itself), and SSH hosts. The Gemini API key and Agent Platform account types are below.

### Antigravity: Gemini API key and Google Agent Platform (ADC) (added 2026-11-24, Orca 1.4.269–1.4.272)

Read from Orca's source (`/Users/bright/src-ref/orca`, commits `d3a843d03`, `04c88e0df`,
`d19c18ea0`): `src/shared/agent-accounts/antigravity/antigravity-chat-auth-config.ts`,
`src/main/antigravity/antigravity-chat-account.ts` (`writeAntigravityChatSettings`, `gcpProjection`),
`antigravity-chat-api-key.ts`, `antigravity-chat-api-key-store.ts`, `antigravity-chat-auth-environment.ts`,
`antigravity-agent-platform-project.ts`, `antigravity-chat-credential.ts`,
`antigravity-acp-environment-sanitizer.ts` (`AUTH_ENVIRONMENT_KEYS`), `antigravity-chat-sign-in.ts`
(`server.authenticate(method)`), `src/main/acp/acp-dialects/antigravity-dialect.ts`
(`TURN_FAILURE_NOTICE`), `acp-reply-notice-failure.ts`, and the renderer's
`components/provider-accounts/AntigravityChatAuthMethodItems.tsx`, `AntigravityChatApiKeyField.tsx`,
`AntigravityChatGcpFields.tsx`, `AntigravityChatAuthForm.tsx`.

Kingu: `src-tauri/src/agent/antigravity_auth.rs` (setting, Keychain, ADC project, launch;
commands `antigravity_chat_auth_status`, `antigravity_api_key_save`, `antigravity_api_key_clear`),
`agent/antigravity.rs` (route, scrub, settings file), `agent/runtimes.rs` (`antigravity_server`
refuses a start without a credential), agent-host `runtimes/acpDialects.ts` (method from the launch,
`failureNotice`) and `runtimes/acp.ts`, webview `accounts/AntigravityChatAuth.svelte`,
`accounts/antigravityChatAuth.ts`, `agent/agentSignIn.ts`, `agent/AgentSignInCard.svelte`.

| | Kingu | Orca |
|---|---|---|
| The setting | `kingu.agent.antigravityChatAuth` (user only): `{method}` with `oauth-personal` (default, written as no key), `gemini-api-key`, or `agent-platform`, with optional `gcpProject` / `gcpLocation` (≤ 255 chars) kept whatever the method, so switching away and back keeps them (Orca). Anything else refuses the start with a sentence naming Settings | `antigravityChatAuth`, `resolveAntigravityChatAuthConfig` |
| Settings | Settings › Accounts › Antigravity: "Sign in with" Google account / Gemini API key / Google Agent Platform (Orca's labels and hints); the key field (password input, Save / Replace / Remove, Get API key → `aistudio.google.com/apikey`) says "saved", "using GEMINI_API_KEY" or neither; Agent Platform has project (placeholder "From gcloud") and location (placeholder `global`) | `AntigravityChatAuthForm` and its fields |
| The key | only in the macOS Keychain, service `dev.kingu.antigravity`, account `gemini-api-key` (`keyring`, like `accounts/secrets.rs`); never in settings, never sent back to the webview or logged. Before saving, `GET generativelanguage.googleapis.com/v1beta/models?pageSize=1` with `x-goog-api-key` (10 s, no redirects, Kingu's proxy): 400/401/403 refuse it, an unreachable Google saves it. A saved key wins over `GEMINI_API_KEY` | Orca seals it with Electron `safeStorage` in `<profile>/antigravity-chat/gemini-api-key.enc`; same check and precedence |
| Agent Platform's project | saved project, `GOOGLE_CLOUD_PROJECT`, ADC's `quota_project_id` (or a service account key's `project_id`) from `GOOGLE_APPLICATION_CREDENTIALS` or `<gcloud config>/application_default_credentials.json`, `CLOUDSDK_CORE_PROJECT`, then `project` under `[core]` of gcloud's active configuration (`CLOUDSDK_ACTIVE_CONFIG_NAME` or `active_config`); location: saved, `GOOGLE_CLOUD_LOCATION`, `global`. gcloud's folder is `CLOUDSDK_CONFIG`, else `~/.config/gcloud` (`%APPDATA%\gcloud` on Windows) | `resolveAgentPlatformProject` |
| Launch | `antigravity-acp/settings.json` = `{"auth":{"type":<method>}}` plus `"gcp":{"project","location"}` for Agent Platform; env keeps only that type's credentials (key: `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`; ADC: `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `CLOUDSDK_CORE_PROJECT`) and sets the saved key, the resolved `GOOGLE_CLOUD_PROJECT`/`LOCATION`, and `GOOGLE_APPLICATION_CREDENTIALS` for an ADC file under `CLOUDSDK_CONFIG`; `KINGU_ANTIGRAVITY_AUTH_METHOD` tells the agent host the method | `antigravityChatAuthEnvironment`, `agentPlatformEnvironment`, `scrubAntigravityAcpEnvironment(…, chatAuth)` |
| Route | a key or ADC account type always runs on Kingu's server, whatever `antigravityGoogleSignIn` says | Orca's first version (`d3a843d03`); 1.4.272 (`d19c18ea0`) moves key chats to an installed agy in an Orca-owned home — not ported |
| No credential | a key chat with neither a saved key nor `GEMINI_API_KEY`, or Agent Platform with no project, is refused before the server starts, with a sentence naming Settings › Accounts › Antigravity | Orca refuses the key case only when a Google login is saved in the chat home (`assertAntigravityChatCredential`) and leaves the rest to the server; Kingu refuses it always, so the server can never fall back to another account |
| Sign in | ACP `authenticate` with the chosen method (the server must list it in `initialize`'s `authMethods`); no link, so the card has no Google button: key → "Open Antigravity settings" (Settings › Accounts, scrolled to Antigravity) and "Try again"; ADC → "Sign in with gcloud" (`gcloud auth application-default login` in a Kingu terminal), "Try again", settings. The `sign_in` event carries `method` | `startAntigravityChatSignIn` (`server.authenticate(method)`) |
| Failure notices | a reply chunk that is wholly `API key not valid. Please pass a valid API key.`, `Agent execution error: failed to create Gemini client: …`, `⚠ UNAUTHENTICATED (code 401): …`, `⚠ agent executor error: …` or a failed agent rebuild fails the turn with that sentence instead of saving it as the answer (server and agy) | `TURN_FAILURE_NOTICE`, `acpReplyNoticeFailure` |

Not built: Gemini Enterprise, key chats on agy (`ANTIGRAVITY_AGY_ORCA_HOME_DIALECT`), restarting
running Antigravity chats when the key changes (they keep their sign-in until they start again).
Needs a real account to verify: a real key against Google, a real ADC login.

**Agent Platform's project in Settings.** Settings shows the project Kingu would pass, the
location, and whether the ADC file exists. Orca `04c88e0df` already names the detected gcloud
project (`main/antigravity/antigravity-chat-auth-detect.ts`, `agentPlatformCredentialsFile`; Chat's
"Use gcloud ({{project}})" in `antigravity-auth-words.ts`), so naming the project is Orca's. Only the
extra detail is Kingu-only: which source the project came from (this setting,
`GOOGLE_CLOUD_PROJECT`, the ADC quota project, `CLOUDSDK_CORE_PROJECT`, gcloud config) and the ADC
file's path, shown in Settings › Accounts rather than in Chat.

**Credentials found on the computer, offered in Chat (Orca `04c88e0df`).** Read from
`src/main/antigravity/antigravity-chat-auth-detect.ts`, `antigravity-chat-saved-sign-in.ts`,
`src/main/runtime/rpc/methods/accounts/antigravity-accounts.ts` (`accounts.antigravityChatAuthDetect`,
`antigravityChatAuthApply`), and the renderer's `components/native-chat/antigravity-auth/`
(`antigravity-chat-auth-choices.ts`, `antigravity-auth-words.ts`, `native-chat-antigravity-auth.tsx`,
`NativeChatAntigravityAuthChip.tsx`, `NativeChatAntigravityAuthChooser.tsx`),
`host-access/NativeChatSignInStrip.tsx`, `composer/controls/NativeChatComposerWorkspace.tsx`.
Kingu: `antigravity_auth.rs` (`detect`, `saved_google_sign_in`, commands
`antigravity_chat_auth_detect`, `antigravity_chat_stop_live`), `host.rs` (`live_runs_of`), webview
`accounts/antigravityChatAuth.ts`, `agent/agyChatAuth.svelte.ts`, `agent/AgyAuthChip.svelte`,
`agent/AgyAuthChooser.svelte` (in `AgentSignInCard.svelte`), `ChatSessionBar.svelte` (`trailing`).

| | Kingu | Orca |
|---|---|---|
| Detection | read from files and the environment only (no server, no gcloud): a Gemini API key saved in the Keychain or `GEMINI_API_KEY` (source `saved` first, else `environment`); ADC = the file `GOOGLE_APPLICATION_CREDENTIALS` or `<gcloud config>/application_default_credentials.json` exists, its project resolved as Agent Platform's launch does with the saved setting (only with the file); a Google sign-in = the server's `<app data>/antigravity-chat/antigravity-acp/acp_token.json` holds a JSON object; the saved method (none while unreadable); running Antigravity chats | `detectAntigravityChatAuth`, `hasSavedAntigravityGoogleSignIn`, `countStructuredAgentChats` |
| The key | the answer says only that a key exists and where; the value never reaches the webview. Choosing it saves the account type `gemini-api-key` and nothing else: an environment key is not copied to the Keychain (the server reads `GEMINI_API_KEY` at launch) | same; Orca's apply writes only the config |
| One-click order | a key (needs no project), then gcloud when it can name a project, then a saved Google sign-in; never the method in use | `antigravityChatAuthAlternatives` |
| Words | "Use your Gemini API key" — "Found GEMINI_API_KEY in your environment" / "Saved in Kingu"; "Use gcloud ({project})" — "Found your gcloud login (Application Default Credentials)"; "Use your Google sign-in" — "You signed in with Google on this computer before"; lead "Kingu found credentials on this computer you can use instead:" | `antigravity-auth-words.ts` ("Saved in Orca", "on this host") |
| Chooser | in the sign-in card of a chat on Kingu's server (`via: browser`) while it isn't busy: the found credentials (first one primary, the hint under each label), "Sign in with Google" when the method isn't Google (the card's own button otherwise), "More options…" / "Use an API key or gcloud instead" to Settings unless the card already links there. A Google sign-in refused for no subscription or an ineligible account says so plainly | `NativeChatAntigravityAuthChooser`, `NativeChatSignInStrip` (`failedLine`) |
| Chip | right end of the row under the input of an Antigravity chat once its route is known: icon and method (gcloud with " · project"), or "agy sign-in" on agy; the menu "Antigravity signs in with" lists Google account / Gemini API key / Google Agent Platform in that fixed order, the current one checked, "Detected" on found ones, "…" and Settings for a key not found or gcloud without a project, then "Sign-in settings…"; on agy, "agy's own login" with its hint and no Google row. Opening it reads detection again | `NativeChatAntigravityAuthChip` in the composer footer, `antigravityChatAuthMenuItems` |
| A switch | reads detection again, asks "Switch to {method}?" / "Antigravity chats running on this computer restart. …" when other Antigravity chats run or the read failed; saves `kingu.agent.antigravityChatAuth` keeping a saved project and location; stops running Antigravity chats (`stop_agent`); "Antigravity now uses {method}." | `decide`, `applyAntigravityChatAuthMethod`, `stopLiveChats` |
| The asking chat | the card's chat isn't counted (it waits on its sign-in); it is stopped and its request sent again with the new sign-in | Orca's strip shows before a chat session holds the server; Kingu's card lives inside the waiting run |

Kingu-only or not ported: no Gemini Enterprise row; Google sign-in from the chooser on a Google
account is the card's own (it signs in within the run and stops nothing, so no confirm); a switch
to a Google account with no saved sign-in lets the resent request's card ask, instead of starting
sign-in itself; the saved-sign-in seed after a restart, the transcript failure rows' recovery offer
(`NativeChatAntigravityAuthRecovery`) and the model listing's sign-in answer are not ported.

## Qwen Code in Chat (checked 2026-11-24, Orca 1.4.271)

Orca 1.4.271 lets bots run Qwen Code; it has been a Chat agent since `38103c8ae`
(`src/main/qwen-code/qwen-code-acp-launch-spec.ts`, `src/main/acp/acp-dialects/qwen-code-dialect.ts`,
`src/shared/agent-session/lifecycle/launch/agent-session-setup-commands.ts`). Kingu already ran it
as an ACP chat agent the way Orca launches it: `qwen --acp`, minimum 0.16.0, `~/.local/bin` install
folder (`agent/runtimes.rs` `KNOWN`), Orca's modes (`default` / `auto-edit` / `auto` / `yolo`), the
`craft/drainMidTurnQueue` and `_qwencode/start_turn` replies and `/clear`, `/reset`, `/new` withheld
(agent-host `acpDialects.ts`). Added now: Orca's `loginCommand: ['qwen']` — a signed-out Qwen chat
waits on the sign-in card, whose "Sign in in a terminal" runs `qwen` (its `/auth` connects a
provider) and "I've signed in" asks again, instead of ending the run. Not ported: Qwen's question
forms, shell-result normalization, `/compress` as `/compact`. Bots are not built.

## Cursor sign-in in Chat (added 2026-11-24)

Orca's Cursor launch spec (`src/main/cursor/cursor-acp-launch-spec.ts`) names
`loginCommand: agentSessionSetupFor('cursor')?.loginCommand`, which is `['cursor-agent', 'login']`
(`src/shared/agent-session/lifecycle/launch/agent-session-setup-commands.ts`), and no authMethod
("`authenticate` while signed out opens a browser and waits"). The installed CLI's `--help`
(2026.11.22) lists `login — Authenticate with Cursor`. Kingu: agent-host `acpDialects.ts`
`'cursor-agent'` gets `signIn: { via: 'terminal', login: ['cursor-agent', 'login'] }` and the label
Cursor, so a signed-out Cursor chat (ACP `-32000` on `session/new`) waits on the sign-in card —
"Sign in in a terminal" runs `cursor-agent login` (Kingu's managed copy's folder is on a terminal's
PATH, after the user's own), "I've signed in" opens the session again — the way agy and Qwen do.

An agent with no sign-in of its own still ends with "Sign in to <program> in a terminal first."
plus the agent's words. The host sends that sentence in English only (it was Thai and English
mixed); the chat shows it in the UI's language (`agentSignIn.ts` `hostErrorText`, also for the
older mixed form kept in saved chats).

## A GitHub account per project (added 2026-11-24, Orca 1.4.271)

Orca 1.4.271's "more than one GitHub account" (`5abc3ebcd`, `689620fe2`) is two things: the Bots
GitHub connector linking several accounts (cloud side; Bots are not built in Kingu) and the
per-project `gh` account every GitHub call of a project uses. Kingu builds the second. Read from
`src/main/github/accounts/gh-account-token.ts`, `gh-capability-state.ts`,
`gh-account-binding-inventory.ts`, `auth-diagnose.ts` (`parseAuthStatus`),
`github-project-account.ts`, `src/shared/github/accounts/account-binding.ts`,
`src/main/git/command-runner/hosted-cli/gh-bound-account-env.ts` and
`src/renderer/src/components/settings/repository/source-control/RepositoryGitHubAccountSection.tsx`.

Kingu: `src-tauri/src/agent/gh_account.rs` (commands `gh_accounts`, `gh_account_validate`; `command`
used by `issues::run_gh`, `pr::gh_run`, `review.rs` PR view/create, `forge.rs`, `agent_pr_create`'s
`--web`), webview `settings/pages/GitHubAccountSetting.svelte`, `settings/pages/githubAccount.ts`,
the project pane's "GitHub account" section (`orcaPane.ts` `PROJECT`).

| | Kingu | Orca |
|---|---|---|
| Binding | `kingu.repo.ghAccount` = `{host, user}` in Kingu's per-repository store (scope `repo`); host lower-cased (optionally `:port`), login without whitespace; a task worktree uses its main checkout's (git common dir) | `repo.ghAccount`, `normalizeGhAccountBinding`, `resolveGitHubProjectAccount` |
| Accounts | `gh auth status` parsed on both streams: host, login, active, scopes; a `(GH_TOKEN)` / `(GITHUB_TOKEN)` login is `env` (listed, not choosable) | `parseAuthStatus` |
| Capability | `gh auth token --help` names `--user` (gh ≥ 2.40): supported (cached for good), unsupported (30 min), unknown (1 min) | `getGhMultiAccountCapability` |
| Each gh call | unless it is `gh auth …`: `gh auth token --user U --hostname H` with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_REPO` removed and prompts off (10 s); the token goes into that child's `GH_TOKEN` (github.com, github.localhost, `*.ghe.com`) or `GH_ENTERPRISE_TOKEN`, with the same ambient variables removed; cached 5 min, a miss 30 s, a timeout not cached; never logged or sent to the webview | `resolveGhAccountToken`, `buildBoundGhChildEnv`, `ghTokenEnvVarForHost` |
| Fails closed | a bound project whose login is gone, or an old gh, gets an error naming `user@host` and `gh auth login --hostname`, never the ambient login | `gh_bound_account_unavailable`, `gh_multi_account_unsupported` |
| Picker | "Default (ambient gh login)", a bound login that is gone shown as "(unavailable)" and not choosable, every login ("user @ host"), Refresh; choosing one is checked first (supported, keyring login on that host, token reads) and only then saved | `RepositoryGitHubAccountSection`, `validateGhAccountBinding` |

Not built: the host-mismatch check against the repository's GitHub host (with SSH alias
resolution; Kingu's token simply only applies to the binding's host), WSL and SSH execution hosts,
Project View on the bound account (Orca keeps it ambient too), Bots' linked GitHub accounts.
Needs real accounts to verify: two keyring logins on one gh.

**Kingu-only: the login that owns origin.** The picker suggests the keyring login named like the
owner of the project's `origin` remote (`git@github.com:alice-work/site` → `alice-work @
github.com`) with a one-click "Use it", hidden once that login is bound. Orca has no suggestion.

## Agent CLIs Kingu installs on an SSH host (added 2026-11-23)

Read from Orca's source (`/Users/bright/src-ref/orca`):
`src/main/runtime/rpc/methods/host-management/managed-runtime-install.ts` (`managedRuntime.install`
/ `.cancel` / `.remove`, a host-management RPC answered by **the host that runs the agent**),
`src/shared/agent-launch/installation/managed-runtime-install.ts` (the state shape),
`src/main/node-runtime/managed-runtime-installation.ts`, `managed-runtime-release-install.ts`,
`src/main/managed-agent-cli/managed-agent-cli-registry.ts` (`MANAGED_AGENT_CLI_IDS`),
`src/main/claude/managed-runtime/claude-managed-runtime.ts` (`claudeManagedPlatform`, the
`downloads.claude.ai/claude-code-releases` manifest), `src/main/codex/managed-runtime/codex-managed-runtime.ts`
(`codexManagedTarget`, `codex-package-<target>.tar.gz`, `codex-package_SHA256SUMS`,
`codexPackageExecutables`), `src/main/node-runtime/linux-libc-probe.ts` (musl vs glibc),
`src/main/managed-server/install/remote-install-root.ts` (`~/.orca-remote`),
`src/main/preflight/installed-agent-detection.ts` and
`src/shared/shell/command-resolution/posix-version-manager-bin-dirs.ts` (PATH probing),
`src/renderer/src/components/managed-runtime/managed-runtime-install-view.ts` (the row).

**Where the download happens.** In Orca the host's own server (`orcad`) runs `managedRuntime.install`,
so on an SSH host the release is downloaded, digest-checked and unpacked **on the host**, for the
host's platform, into the host's data folder. Kingu follows that: the host downloads and checks.
Kingu has no server there, so the steps are a shell script sent over the shared ssh connection; only
the release *lookup* (version, URL, size, digest) runs on this computer, with the same
`agent/managed_cli/pin.rs` code as local installs, so no JSON is parsed by a shell on the host.

Kingu: `src-tauri/src/ssh_agent_install.rs` (commands `ssh_agent_installs`, `ssh_agent_install`,
`ssh_agent_install_cancel`, `ssh_agent_remove`; event `ssh-agent-install:changed`),
`ssh_agents.rs` (`~/.kingu/bin` appended last to the fallback folders);
`src/lib/ade/sshAgentInstall.ts` (rows, the question, Never answers), `sshAgentInstalls.svelte.ts`,
`SshAgentsPanel.svelte` (SSH Hosts › Agents), `sshProjects.svelte.ts` (the missing-agent prompt
offers "Install {agent} on {host}…").

| Rule | Kingu | Orca source |
|---|---|---|
| Catalog | Claude Code, Codex, OpenCode, OpenCode 2, Cursor, GitHub Copilot, Kimi Code, OMP, Antigravity `agy`. Grok is left out: its npm package ships the program brotli-compressed and hosts rarely have `brotli`. Antigravity's ACP server (`antigravity-server`) is left out too: it is no terminal command and only runs this computer's chats, so it showed as a second, uninstallable "Antigravity" row (fixed 2026-11-24). OpenCode 2 keeps Orca's name (`agent-catalog-entries-primary.ts` `opencode2_label`), as in Settings › Agents | `MANAGED_AGENT_CLI_IDS` |
| Platform | `uname -sm` → macOS / Linux on x86_64 / arm64; on Linux musl when `ldd --version` says `musl libc` or `/lib/ld-musl-*.so.1` exists. Each publisher's name: Claude `linux-x64[-musl]`, Codex `x86_64-unknown-linux-musl` (static, serves glibc too), the rest as for local installs | `claudeManagedPlatform`, `codexManagedTarget`, `parseLinuxLibc` |
| Tools | `curl` (else `wget`) to download; `sha256sum` / `sha512sum`, else `shasum -a`, else `openssl dgst` to check; `tar` + `gzip` for a tar.gz, `unzip` for a zip (OpenCode's macOS builds: the ACP Registry's `darwin-*` archives are `.zip`; until 2026-11-24 Kingu refused every zip, so OpenCode and OpenCode 2 read "no build Kingu can install for darwin-arm64"). A host without a downloader or a checksum tool is refused (the holder's upload tolerates no tool only because Kingu verified that binary itself) | the host server's own Node; `src/shared/archives/zip-extractor-command.ts` (`unzip -q <zip> -d <dir>` on POSIX) |
| Asked first | nothing is installed until the user presses Install in SSH Hosts › Agents, or picks "Install {agent} on {host}…" in the missing-agent prompt and answers **Install** to Install / Not now / Never offer {agent} for this host (the SSH holder's pattern). Never is kept per host and agent (`kingu.ssh.agentInstallNever`) and undone in the panel | Orca installs from its Install buttons |
| Download | `curl -fsSL --proto '=https'` of the pinned URL to `~/.kingu/agent-runtimes/<agent>/.download-<pid>`; the file size is printed every second as progress, and a body larger than published is stopped | `runtime-archive-download.ts` |
| Digest | the size must equal the published size and the sha256 / sha512 must match before anything is unpacked; otherwise exit 22 and nothing is kept | `downloadVerifiedArchive` |
| Unpacking | `gzip -dc | tar -xf -` (a zip: `unzip -qo … -d`) into `.incoming-<pid>/` after listing the archive (`tar -t` / `unzip -Z1`): an absolute path, a backslash in a zip member or a `..` component refuses it (the host's `tar` does the rest; Kingu's local unpacker is stricter about links) | `managed-runtime-release-install.ts` |
| Prepare | as local: OMP gets `manager.json`, `antigravity` is renamed `agy`; every program the release needs must be there (Codex: `bin/codex`, `bin/codex-code-mode-host`, `codex-path/rg`, Linux `codex-resources/bwrap`) and is made executable | `codexPackageExecutables`, `prepare` |
| Start check | `<command> --version` (60 s with `timeout` when the host has it; agy with `AGY_CLI_DISABLE_AUTO_UPDATE=true`) must contain the release's version before publishing | `requireRuntimeAnswersVersion` |
| Where | `~/.kingu/agent-runtimes/<agent>/<version>/` (receipt `.install-complete` written before the rename that publishes it) and a two-line launcher `~/.kingu/bin/<name>` (`exec "$HOME/.kingu/agent-runtimes/…" "$@"`, marked `# Kingu-managed <agent>`; a file of the user's with that name is never replaced). No sudo, nothing outside `~/.kingu` | `~/.orca-remote`, `<userData>/agent-runtimes` |
| Who wins | the user's own copy: the detection walk (login PATH, then the version-manager folders) finds it first; `~/.kingu/bin` is the last fallback folder, so a terminal starts Kingu's copy by its absolute path only when nothing else is there. A row says "Uses the copy found on this host" | `findExternal` |
| Progress / cancel | Download (bytes of the published size), Unpack, Check; Cancel closes the ssh channel, the script's next progress line fails and its trap removes the staging folder and download. A Cancel after the publishing rename ends in success, as Orca's does. 45-minute deadline | `ManagedRuntimeOperation`, `DEADLINE_MS` |
| Update | an installed copy whose version is behind the latest shows Update; installing publishes the new folder and removes older ones no process on the host runs from (Kingu does not update host copies by itself) | `startManagedRuntimeAutoUpdates` |
| Remove | asks first; refused while a process's command line names the agent's folder under this user's `$HOME` (or when the host lists no processes); deletes the folder (renamed first) and only Kingu's launchers | `managedRuntime.remove`, the launch-gate fence |
| Errors | the script's own `kingu-install: …` line (no downloader, download failed with curl's last line, size, checksum, unsafe archive, missing program, wrong version, running) is shown under the row | `installFailureText` |

Estimated / differs from Orca: Claude follows the `latest` channel (Orca reads the host's
`autoUpdatesChannel`); a host with no internet access, or without curl/wget, can't install (Orca's
host server needs the network too; Kingu does not fall back to downloading here and uploading);
host copies are not kept current automatically.

## Chat resilience: resume after a restart, continue after a usage limit, delete (added 2026-11-24)

From Orca 1.4.271 ("delete chats, continue after a usage limit") and 1.4.272 ("resume chats and
workers after a crash or restart"). Read from Orca's source (`/Users/bright/src-ref/orca`):

- Restart: `src/shared/agent-session/lifecycle/stopping/agent-session-restart-continuation.ts`
  (the continuation message and notes), `src/shared/agent-session/lifecycle/resume/agent-session-resume-marker.ts`
  (triggers `quit`/`update`/`crash`, removed on a new message, resume, dismissal or delete),
  `src/main/native-chat/agent-session-wire/recovery/structured-agent-session-interrupted-continuation.ts`,
  `src/shared/native-chat/transcript/continuation/native-chat-interrupted-continue.ts`,
  `src/renderer/src/components/native-chat/usage/NativeChatInterruptedContinue.tsx`,
  `src/renderer/src/components/native-chat-recovery/offers/native-chat-resume-on-restart-store.ts`
  (`loadNativeChatLaunchOffer`: a Resume toast when the setting is off, the run when on;
  `noteTerminalWorkerRestartOffers`), `native-chat-launch-resume-decision.ts`,
  `src/renderer/src/components/settings/chat/ChatBehaviorSetting.tsx` (`nativeChatResumeWorkOnRestart`).
- Usage limit: `src/shared/agent-session/failures/agent-session-usage-limit.ts` (windows, a reset
  within a month, `formatUsageLimitResetClock`), `src/main/claude/structured/journal/claude-limit-line.ts`,
  `claude-usage-limits.ts` (pooled 429, `rate_limit_event` rejections), `src/main/codex/structured/catalog/codex-usage-limits.ts`
  ("try again at"), `src/shared/native-chat/transcript/continuation/native-chat-usage-limit-cut.ts`
  (`NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE`, `NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS`,
  `isNativeChatUsageLimitCutSchedulable`), `native-chat-usage-limit-auto-continue.ts`,
  `src/shared/native-chat/settings/native-chat-usage-limit-auto-continue.ts` (on by default),
  `src/renderer/src/components/native-chat/usage/NativeChatUsageLimitRow.tsx`, `native-chat-usage-limit-row-words.ts`,
  `use-native-chat-usage-limit-auto-continue.ts`, `use-usage-limit-continue-clock.ts`,
  `src/shared/agent-session/failures/agent-session-failure-copy.ts` (the words).
- Delete: `src/renderer/src/lib/agent-session/chat-deletion/orca-chat-delete.ts` (confirm with
  "don't ask again", `skipDeleteChatConfirm`), `src/shared/agent-session/chat-deletion/orca-chat-delete.ts`
  (refusals), `src/renderer/src/components/native-chat/drafts/native-chat-composer-draft-removal.ts`.

Kingu: `src/lib/agent/chatResume.ts`, `chatLimits.ts`, `chats.svelte.ts` (`#resumeCutOff`,
`resumeInterrupted`, `dismissInterrupted`, `continueAfterLimit`, `cancelAutoContinue`,
`#armLimits`/`#fireLimits`, `#noteLimit`, `remove`), `ChatResumeNotice.svelte` (above the composer),
`AgentPanel.svelte` (delete confirm); `src/lib/ade/workerResume.ts`, `workerResume.svelte.ts`,
`cliSessions.svelte.ts` (`load` reports CLIs that are gone); `src-tauri/src/agent/chats.rs`
(`ChatMeta.usage_limit`, `ChatMeta.interrupted`, `Transcript::checkpointing`, `cut_off`,
`load_partial`), `agent/mod.rs` (`chat_cut_off`); settings `kingu.chat.resumeWorkOnRestart`,
`kingu.chat.autoContinueAfterUsageLimit`, `kingu.chat.confirmDelete`.

| Rule | Kingu | Orca source |
|---|---|---|
| Cut off by a restart | a chat saved `working` with a session and no run at the folder's first load; marked `interrupted {at, crash}` in chats.json until a new message, Continue or Dismiss | resume marker, `removed on a non-continuation start, successful resume, dismissal or chat close` |
| Quit or crash | `crash` when the transcript's last event (feedback and Rust-only lines aside) is not the run's `exit`: Kingu's quit ends runs through the sidecar's `shutdown`, so a quit leaves an `exit`. Orca writes the trigger at teardown; Kingu reads it back, so a quit whose `exit` was lost reads as a crash | `AGENT_SESSION_RESUME_MARKER_TRIGGERS`, `cause: 'crash'` |
| Setting on | each cut-off chat is sent the continuation message at once; a status flash counts them | `loadNativeChatLaunchOffer` (`autoResume && !hostContinues`) |
| Setting off | one notification for the folder ("… was working when Kingu quit" / "closed unexpectedly") with Resume and Always Resume (turns the setting on and resumes), and a row in each chat: title by cause, Continue / Dismiss, hidden while a turn runs | `requestNativeChatResumeOnRestartDialog`, `NativeChatInterruptedContinue` |
| The message | Orca's words with Kingu's name: "Kingu restarted, so your previous reply was cut off partway through. Before continuing, check whether your most recent action completed — don't repeat it if it did. Then carry on." | `AGENT_SESSION_RESTART_CONTINUATION_MESSAGE` |
| Default | `kingu.chat.resumeWorkOnRestart` stays off (Orca: on for new profiles, off for profiles saved before the setting) | `default-global-settings.ts`, `keepResumeOnRestartOffForExistingProfiles` |
| Workers | a task's agent CLI whose terminal did not survive (a reboot, the terminal daemon gone; cliSessions finds it gone) and whose task is not done: Reopen in a notification starts it again in its worktree, continuing its session (`attempts.resume`); at once with the setting on. No message is typed into it | `noteTerminalWorkerRestartOffers`, `orca-runtime-terminal-worker-restart-resume.ts` |
| Usage limit found | the latest turn (after the last user message) failed — an error `result`, an `error`, a failed `exit` — and its words are Claude Code's limit line (`Claude AI usage limit reached\|<s>`, `You've hit your … limit · resets 3pm (Zone)` read in that zone, `Nov 27, 3pm`), a pooled-accounts 429 (`earliest reset at <ISO>`), Codex's `You've hit your usage limit … try again at 3:05 PM.` (local time, end of the minute), or a quota error (`RESOURCE_EXHAUSTED`, `quota exceeded`); a `rate_limit_event` with `status: rejected` (no overage) seen in the run fills in the window and reset the words lack. A reset more than 31 days away is dropped. A plain "rate limited" is not a usage limit | `claudeLimitLine`, `claudePooledUsageLimit`, `ClaudeUsageLimits.record`, `codexUsageLimitResetFromText`, `usageLimitResetsAt` |
| Kept | `usage_limit {at, resets_at, window, auto_off}` in chats.json; cleared by the chat's next message (before its run starts, so the turn's own events can set a new one) or Dismiss | `latestNativeChatUsageLimitCut` (derived from the journal) |
| The row | "{agent} usage limit reached" / "weekly limit" / "extra usage limit"; "You can continue at 3:00 PM." / "{agent} can continue now." / "Reset time unknown."; "Kingu will continue this chat at …" with Cancel, "Kingu won't continue this chat automatically." with Continue automatically, or, with the setting off, a link that turns it on; Continue and Dismiss. Times in this machine's clock, today's without the day; re-read every 30 s and on focus | `native-chat-usage-limit-row-words.ts`, `formatUsageLimitResetClock`, `useUsageLimitContinueClock` |
| Continue | sends "Continue where you left off." Kingu lets it be pressed before the reset too (styled secondary, with a hint): Orca enables it before the reset only after an account switch, which Kingu's chats do not have | `NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE`, `continueAt` |
| Automatic continue | `kingu.chat.autoContinueAfterUsageLimit`, on by default: at a known reset after the turn ended and at most a day overdue, unless cancelled; one timer for the open folder, woken at the soonest reset and at least every minute (sleep, clock change); a chat that is busy or whose send fails is marked cancelled instead of retried. Only the open folder's chats (Orca: every chat of the host) | `isNativeChatUsageLimitCutSchedulable`, `NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS`, host scheduler |
| Delete | refused while the chat's agent runs (Rust too); asks "Delete the chat … ?" with Delete / Delete, Don't Ask Again / Cancel unless `kingu.chat.confirmDelete` is off; deletes the transcript, its edits store and its checkpoint file, the composer draft, and the chat's side chats | `useDeleteOrcaChat`, `skipDeleteChatConfirm`, `deleteNativeChatComposerDraft` |

**Kingu-only: crash-safe checkpoint of the streamed reply.** Orca's journal keeps whole messages,
so a reply that was streaming when the app died is gone (and Claude Code's own session log keeps
only whole messages, so the agent never saw where it stopped). Kingu's run transcript
(`Transcript::checkpointing`, chat runs only) keeps the main agent's text deltas in
`.kingu/chats/<id>.partial.json`, written (tmp + rename, `O_NOFOLLOW`) with the first chunk and
then at most every 250 ms; the whole assistant message or the turn's result drops it. At the run's
`exit` (a quit, a stop) a cut reply goes into the transcript as the agent's message before the
`exit`; after a crash the file stays: reopening the chat shows it as the last message, the
interrupted row says "The reply it was writing was saved up to where it stopped", Continue quotes
its last 600 characters to the agent in `<cut-off-reply>`, and the chat's next run folds it into
the transcript for good. Thinking is not checkpointed. Up to 250 ms of text can still be lost.

Not built: Orca's per-account usage-limit holds and account switching (Kingu has no chat-level
account switch), host-side scheduling for chats of folders that are not open, the update-install
trigger wording, remote-host chats, and the phone's delete (Kingu's phone page has no chats).

## `/btw` and `/side`: side questions beside a chat (added 2026-11-24, Orca 1.4.272)

Read from Orca's source (`/Users/bright/src-ref/orca`):
`src/shared/native-chat/input/commands/native-chat-side-chat-command.ts` (the commands and their
refusals) and `src/renderer/src/components/native-chat/messages/actions/use-native-chat-side-chat.ts`
(the fork and the drawer).

Kingu: `src/lib/agent/sideQuestion.ts` (`parseSideDraft`, `sideForkPoint`, `sideRefusal`),
`AgentPanel.svelte` (`sideCommands`, `askSide`, checked in `submit` before every other command),
`SideChat.svelte` (the drawer that VS Code's Ask in Side Chat also uses).

| Rule | Kingu | Orca source |
|---|---|---|
| The commands | `/side <question>` and its alias `/btw <question>`, as the whole message. Listed in the `/` menu as "Ask a side question in a fork beside this chat" | `native-chat-side-chat-command.ts` |
| Where it goes | the chat is forked (`chats.fork` with `side`) through its newest finished response, and the question is sent to the fork, in the side chat drawer. The chat's own agent gets nothing, and its running turn goes on | `use-native-chat-side-chat.ts` |
| While a reply runs | the fork is cut before the running request, so it copies only finished turns. When no earlier turn has an answer, or the running request's index is unknown, the command says "Available when this reply finishes." | same |
| Before the first reply | "Available after the first reply." (in the `/` menu row and as a status message) | same |
| Attachments | refused: "Side chats take text only. Remove attachments, then send it again." | same |
| Which agents | only agents Kingu can fork (`features.rewind`: Claude Code, Arkai). For other agents, `/btw` is sent to the agent as ordinary text | – |
| The drawer | Keep as Chat moves the fork into the history and opens it. Closing the drawer or leaving the chat discards the fork, stopping it first if it runs | Orca's side chat panel |

Tests: `src/lib/agent/sideQuestion.test.ts`; e2e `e2e/chat-composer-later.spec.ts` ("/btw asks a
side question in a fork beside the chat").

## Agent browser use (added 2026-11-24, VS Code 1.147; Orca 1.4.269 compared)

Read from VS Code's source (`/Users/bright/src-ref/vscode`,
`src/vs/workbench/contrib/browserView/electron-browser/tools/` and
`features/browserEditorChatFeatures.ts`) and Orca's (`/Users/bright/src-ref/orca`,
`src/main/browser/agent-browser/`, `src/shared/browser/automation/orca-browser-cli-commands.ts`).
Orca lets any local agent drive the worktree's tabs through its CLI and asks nothing first; VS
Code asks, and Kingu follows VS Code. docs/IDE-PARITY.md §20 has the feature table.

Kingu: `src-tauri/src/floating_browser/agent.rs` (sessions, pages, steps, the log, replay,
`floating_browser_capture`), `apps/agent-host/src/browser.ts` (the MCP tools and what asks),
`apps/agent-host/src/browserMcp.ts` (the loopback MCP server for Codex and ACP agents),
`runtimes/session.ts` `browserGate` (what asks, for every runtime that is not the SDK),
`arkai/session.ts` (Arkai's own browser tools),
`src/lib/workbench/agentBrowser.ts` and `agentBrowser.svelte.ts` (the tab's indicator, Share with
Agent, Log, Add Screenshot to Chat), `src/lib/agent/chatContextSources.svelte.ts` (Add Context ›
Browser Screenshot).

| Rule | Kingu | Upstream |
|---|---|---|
| Switch | `kingu.browser.agentTools`, off by default. Only a chat run started while it is on gets a session token (sent to the agent host on stdin, never in the environment) | VS Code `workbench.browser.enableChatTools` (on by default); Orca: always on |
| Who can drive | every chat runtime (added 2026-11-24): a Claude run through Kingu's in-process MCP server `kingu`; an Arkai run through its own tools of the same names (`mcp__kingu__<tool>`; not for a light model); a Codex or ACP run through Kingu's MCP server on loopback (`browserMcp.ts`, Streamable HTTP with plain JSON answers). All of them end in the agent host calling `browser.*` on the `kingu` socket with the run's token. No tools when a server of the run is already named `kingu`. The `kingu` command has no browser method, so a terminal agent cannot drive a page | VS Code: chat agents; Orca: any local caller (`rpc-method-permission.ts`), through the `orca` CLI and its bundled skill, for every agent alike |
| Secrets for Codex and ACP | the app's token never leaves the agent host. Each run gets its own random secret (32 bytes), known only to the agent host (kept as its SHA-256) and ended with the run; it reaches the agent as an `Authorization: Bearer` header in the run's MCP config over the agent's own stdio: Codex's `thread/start` / `thread/resume` `config` (`mcp_servers.kingu.url`, `.http_headers`, as Orca adds a Codex bot's tools as thread config, `bot-tools-codex.ts`), an ACP agent's `session/new` `mcpServers` entry of type `http`. Never in an environment or on a command line. An ACP agent without `mcpCapabilities.http` gets no browser tools (a stdio server would need the secret in its env or argv); a Codex config with its own `mcp_servers.kingu` wins (Orca `isTakenByCodexStdio`). The server listens on 127.0.0.1 only and refuses a request with an `Origin` or another `Host` | Orca: the CLI finds Orca's runtime by its own files |
| What asks | opening a page, and navigating to an address (not back, forward or reload): Allow once, in this Session, in this Workspace, Always. Reading, clicking, typing, screenshots and Orca's reads do not ask; in plan mode every call asks, in Allow all none does. For Arkai, Codex and ACP Kingu asks before the call runs (`browserGate`, the same card and VS Code's words), and an "always" answer of any scope lasts for the run (those runtimes keep no rules file; Claude's go to its settings scopes). Codex's own approval for the server is off (`default_tools_approval_mode = "approve"`, `tool_timeout_sec = 600`), so it does not ask twice; an ACP agent may still ask with its own card | VS Code `prepareToolInvocation`; Orca asks nothing |
| Orca's reads (added 2026-11-24) | `wait_for_page` (Orca's `wait`: a CSS selector visible or hidden, text, a URL glob with Playwright's `**` / `*` / `?`, a load state `load` / `domcontentloaded` / `networkidle`; all given must hold; default 25 s as Orca's `BROWSER_WAIT_DEFAULT_TIMEOUT_MS`, at most 60 s; no condition: a pause. Orca's `--fn` is left out: an agent runs no JavaScript of its own in a page). `read_console` and `read_network` (Orca's `console` and `network requests`: level and text; method, status, URL, content type and size; `limit` keeps the last n, as Orca's `keepLast`). Kingu has no CDP, so the page's own world records them (`CAPTURE_JS`: console methods, `fetch`, `XMLHttpRequest`, the performance timeline), the last 500 of each per document: an agent page from its first script on every load, a shared tab from the first read on (the agent is told; resource loads come from the timeline either way). `read_cookies` (Orca's `cookie get`): only on pages an agent opened, all cookies of the page's own store (or those for a `url`), HttpOnly included. A tab the user shared refuses it: Orca's agents drive the user's own profile and read its cookies, but Kingu follows VS Code's sharing, whose tools read no cookies, so a shared tab lends its logins to use, never to read | Orca `agent-browser-bridge.ts` `cookieGet` / `consoleLog` / `networkLog`, `agent-browser-wait-arguments.ts`, `agent-browser-log-entries.ts` |
| Which pages | pages the agent opened (an in-memory store of their own, not the user's cookies) and tabs the user shared with Share with Agent, which asks first and names the cookies. Stop takes a page back; a stopped page refuses every call | VS Code `BrowserViewStorageScope.Agent`, `setSharedWithAgent`; Orca: the caller's worktree tabs and their profile |
| While it drives | the window gets `agent-browser` events: the tab shows who drives it and what it does, with Stop. Memory Saver does not free a page an agent may use | VS Code's shared-page border; Orca `BrowserClientPageMemorySaver.track` |
| The log (Kingu-only) | every step, in memory until quit (500 entries): Log on the indicator lists them; Replay re-runs the navigations, clicks and typing on the tab until a step fails (reads and screenshots are skipped, an `open` becomes a navigation); Copy log as JSON. Text typed into a password field is never kept or replayed | – |
| Pictures | Add Screenshot to Chat (toolbar) and Add Context › Browser Screenshot save the tab's visible page with the pasted images and attach it. WKWebView snapshot: macOS only | VS Code `addScreenshotToChat` |

Tests: `src/lib/workbench/agentBrowser.test.ts`, `apps/agent-host/test/browser.test.ts`,
`apps/agent-host/test/browser-runtimes.test.ts` (the MCP server over real HTTP; Codex and an ACP
agent as child processes, what Kingu wrote to them and how it started them; Arkai against a fake
model), the Rust tests in `floating_browser/agent.rs`; e2e `e2e/agent-browser.spec.ts`. Not yet
run against a real Codex, ACP agent or page: the capture script, a real wait, WebKit's cookie
store for an agent page, and how each agent treats the server's tools.

## Browser tools for an agent on an SSH host (added 2026-11-24, Orca 1.4.272)

Read from Orca's source at e691a02c9 ("browser tools/extensions work across SSH and paired
server"): `src/shared/browser/client-hosting/desktop-browser-bridge-protocol.ts` (the method
allowlist, the `desktop_browser_bridge_unavailable` refusal),
`src/main/runtime/desktop-browser-bridge/desktop-browser-bridge-registry.ts` and
`desktop-browser-bridge-route.ts` (orcad forwards a local CLI's `browser.*` call to the newest
attached desktop, never runs it in the host's own browser, and rejects pending calls when the
desktop detaches), `src/main/runtime/rpc/methods/browser/desktop-browser-bridge.ts` (the attach
subscription), `src/main/browser/desktop-browser-bridge/desktop-browser-bridge-executor.ts` and
`desktop-browser-bridge-connection.ts` (the desktop checks the method again, scopes it and runs
it). How Orca protects the host's socket: `src/main/runtime/rpc/transports/unix-socket-transport.ts`
(`chmodSync(endpoint, 0o600)`), `src/main/runtime/rpc/server/runtime-rpc-request-admission.ts` (a
random 24-byte `authToken` per orcad process, checked on every request) and `runtime-metadata.ts`
(the token in a 0600 file, `writeSecureJsonFile`).

Kingu has no server on the host, so a dedicated `ssh -N -R` per agent run is the relay.
Kingu: `src-tauri/src/ssh_browser_relay.rs` (this side), `crates/kingu-ptyd/src/browser_relay.rs`
(the wire protocol and the host's MCP server, `kingu-ptyd browser-mcp --run <run>`),
`src/lib/ade/sshBrowserRelay.ts` (the grant prompt, asked through `cliBridge.svelte.ts`). The pages
and steps are the local agent browser's (`floating_browser/agent.rs`, above).

| Rule | Kingu | Orca |
|---|---|---|
| Who gets it | a claude started in a **held** terminal on the host (`ssh_project_terminal`) while `kingu.browser.agentTools` is on: `--mcp-config` (added last, since the flag takes several values) names `kingu-ptyd browser-mcp` from the holder's folder. Other CLIs and unheld terminals don't get it yet | the `orca` CLI on any managed SSH host, when the host's setting allows it |
| Path of a call | agent → MCP tool → `~/.kingu/host/browser/<run>.sock` on the host → `ssh -R` → a 0600 socket in a 0700 temp folder here (peer uid checked) → the token check → agent.rs | `orca` CLI → orcad socket → the desktop's attach subscription over SSH |
| Authentication, per run | the host folder is 0700 and sshd binds the socket 0600; the run's 32-byte token goes to `<run>.token` (0600) on ssh's stdin, never in argv; every request carries it, compared in constant time. The MCP server refuses a token file or folder another user owns or could read. Another user on the host can't reach the socket; another run of the same user lacks the token | 0600 socket + per-process token in a 0600 file |
| What it may do | the six tools only (`agent::METHODS`); the host's `session`/`cwd` params are dropped and the run's own session is used, so pages it opens use storage of their own | an allowlist of browser commands; no cookies, clipboard, profiles or raw commands |
| What asks | opening a page and navigating to an address ask here first: Allow Once, Allow for This Run, Deny (Escape declines). Stop on a page of the run takes "for This Run" back, so the next one asks again. Reading, clicking, typing and screenshots don't ask (VS Code's rule, as for a local chat) | nothing is asked; the host's setting is the grant |
| Indicator and Stop | the tab's agent indicator (agent.rs) names the run (`box run 0123abcd`) and has Stop; the log keeps its steps | the tab says which host controls it |
| Connection drops | `ssh -R` keeps the shared connection's keepalives (ends within 45 s); calls then fail with "can't be reached … Nothing ran"; a call cut off mid-way gets the same. Kingu dials again (2, 5, 10, 30, 60 s backoff) while the run lasts; each dial removes the stale host socket first, since `StreamLocalBindUnlink` is sshd's setting for `-R` (off by default) | pending calls rejected with `desktop_browser_bridge_unavailable` |
| End | closing the run's terminal (`ssh_remote_hook_clear`) stops the relay and removes the token and socket from the host; quitting Kingu kills the `ssh -R` children | the attachment ends with the connection |

**Needs a real host to confirm:** a claude on a Linux host loading the MCP server from the holder
(the holder binary must be rebuilt with `tools/build-ptyd-host.ts`), and sshd configs that turn off
`AllowStreamLocalForwarding` (the relay then shows `lost` with ssh's error). Tested against a
local OpenSSH sshd (the ignored `ssh_browser_relay::tests::e2e_over_a_real_ssh`, with
`KINGU_SSH_CONFIG`).

Tests: Rust `ssh_browser_relay.rs` and `kingu-ptyd` `browser_relay.rs`;
`src/lib/ade/sshBrowserRelay.test.ts`; e2e `e2e/ssh-browser-relay.spec.ts`.

## Floating workspace toggle keeps clear of the composer (added 2026-11-24)

Read from Orca's source (`/Users/bright/src-ref/orca`,
`src/renderer/src/components/floating-terminal/trigger/floating-terminal-trigger-keep-clear.ts`,
`floating-terminal-trigger-position.ts` and `FloatingTerminalToggleButton.tsx` in the same folder).
Orca marks its chat dock (`native-chat/pane/dock/NativeChatDock.tsx`) and an item's comment box
(`bots/items/BotItemCommentBox.tsx`, `BotItemStepper.tsx`).

Kingu: `src/lib/workbench/floating.ts` (`keepButtonClear`, `defaultButton`), `floatingKeepClear.svelte.ts`
(the `{@attach keepFloatingToggleClear()}` registry), `floating.svelte.ts` (`buttonAt`, `commitButton`).
Marked: the chat composer (`Composer.svelte`), the chat input stack in `AgentPanel.svelte` (Orca's
dock) and the issue drawer's comment box (`IssueDrawer.svelte`, as Orca's item comment box).

| Rule | Kingu and Orca |
|---|---|
| Default spot | bottom right, 24px from the right and 72px from the bottom; a window narrower than 440px puts it top right under the title bar (offset 72). Until the user drops it, the default follows the window's width |
| Keeping clear | a marked box's rect, and the bottom of the box laying it out (its pane), are measured on resize, on the box's or its column's resize and on boxes added to the column. Where the button would cover one, it shows 8px below it when that fits above the pane's bottom (and the window), else 8px above; a spot landing on another box is skipped, the first spot (clamped) if none is clear |
| Dragging | the button follows the pointer over anything; when dropped, it shows and is saved clear of the marked boxes, anchored to the nearest corner. Nothing is saved in a window too small to place it |

Tests: `src/lib/workbench/floating.test.ts`; e2e `e2e/chat-composer-later.spec.ts` (a real right-click on Send).

## Orca items, questions and checks round (checked 2026-11-24, Orca 4e8e3501e..4d949c6a6)

Fifteen Orca commits after 7ebb8cfbd, read in `/Users/bright/src-ref/orca`. Most change Orca's bot
items (an item page, its questions, comment answers, link chips, the CLI's work lists); Kingu has
no bots, so those were read and left out. What maps:

| Orca commit | What it does | Kingu |
|---|---|---|
| 207212b6b `feat(checks): show skeletons while checks and comments load` | Until the first read of a PR's comments settles, the comments list shows placeholders shaped like two comment cards and the audience tabs (`comments/comments-list-loading.tsx`), never "No comments"; a refresh of the same PR keeps what was loaded, and only a change of host/PR (`commentsReadIdentity` in `review-data/use-checks-panel-review-data.tsx`) resets it; a read error shows only when no comments are loaded (`emptyReadError`); placeholders fade in after 150 ms, none with reduced motion; a screen reader hears "Loading review details…" 400 ms into a cold read (`presentation/checks-panel-loading-announcement.tsx`) | **ported**: `src/lib/ade/AdeChecks.svelte` (`commentsRead`, `commentsIdentity`, `coldComments`, `announce`, `.skeleton-in`); `src/lib/ade/PrComments.svelte` keeps read threads in view when a refresh fails; string `forge.checks.loadingReview` (en, th). Orca's checks skeleton (`presentation/checks-list-loading.tsx`) has no Kingu counterpart: Kingu's checks come in the same `gh` read as the PR, whose cold state already says "Checking…" |
| 85a6a2def `Use the question bubble for blocked agents` | A blocked agent draws the needs-you question glyph (`components/agent/status/AgentStateDot.tsx`); red stays for failed (`dashboard-subagent-cards.ts` `failed`) | **already equivalent**: `ade/programStatus.ts` folds a `blocked` report (and a blocked child) into `permission`, which `ade/CardStatusDot.svelte` draws as the question mark; only `failed`/`error` is red. The mobile and native-chat background-task parts have no Kingu counterpart |
| 76ba3525d `Fix agent history badges at narrow widths` | The history-size badge wraps below the title and wraps its own text (`settings/form-controls/SettingsTitleWithBadge.tsx`, `wrap-anywhere`) | **ported**: `src/lib/settings/pages/WorkspaceCleanupPage.svelte` codex badge (`[overflow-wrap:anywhere]`, no `whitespace-nowrap`); the row already wrapped (`flex-wrap`) |
| 06f0ca1a8 `fix(orchestration): say what is known when a worker goes quiet` | Copy of the run-mailbox escalation after ~10 min of silence (`workers/turn-stops/worker-model-wait-report.ts`) | skipped: Kingu's orchestration (`src-tauri/src/agent/orchestration.rs`) fences dispatch depth only; it has no worker mailbox or silence watch |
| d16db9253 `write lines name the item; ask tips and worker titles…` | Item CLI lines; a worker title derived from its spec drops Markdown marks (`shared/markdown/markdown-plain-line.ts`, `shared/orchestration/orchestration-task-display.ts`) | skipped: item parts are bots; `kingu task create` requires an explicit `title` (`cli_server.rs` `check_create`), so no title is derived from a spec |
| 8d25f6f84 `Keep workspace deletion review at a stable size` | Rebuilds the delete dialog's child-workspace (lineage) review at a fixed size | skipped: `ade/RemoveTaskDialog.svelte` has no child-workspace review to resize |
| 4d949c6a6 `fix(dock): re-check Stop and Retry against the live dock` | Native chat's worker dock | skipped: Kingu has no worker dock |
| 4e8e3501e, bb95a42ed, 39c56e396, 9ccab10c6, 5b684518c, ad96411db, 212a1f746, 56e27bb62 | Bot items: all open questions with one Send, compact item header and Reply jump, old question-line parsing, Needs you kept while a worker starts, group-item chat filter, PR links without cached state in work lists, GitHub card on item link chips, item-page PR refresh | skipped: bots (not built in Kingu) |

## Orca native chat and agent runtimes round (checked 2026-11-24, Orca 7ebb8cfbd..907b43c04)

Fourteen Orca commits on native chat and agent launch, read in `/Users/bright/src-ref/orca`
(`git show <sha>`). What maps:

| Orca commit | What it does | Kingu |
|---|---|---|
| 907b43c04 `fix(claude): keep a positional prompt from being read as a variadic flag's value` | claude's argv launch prompt goes after `--` (`shared/agent-launch/catalog/tui-agent-config.ts` `argvPromptSeparator: '--'`, `startup/argv-prompt-separator.ts`), so default args ending in a variadic flag (`--disallowedTools Agent`, `--debug`) no longer take the prompt and start an empty session; no second `--` when the agent's options already end with one (`agentArgTerminatorIndex`); none when the command override is a non-claude wrapper such as Happy (`findClaudeExecutableIndex` finds no claude), since the wrapper appends its own flags | **ported**: `src/lib/ade/agentProfiles.ts` (`claudePrompt`, `claudeStart`, the claude profile's `launch`: session id, `--settings`, `--plugin-dir` and the variadic `--mcp-config` now come before `--` and the prompt), `src/lib/agent/launchSpec.ts` (`applyLaunchSpec` drops the separator when `kingu.agent.cmdOverrides.claude` names a program that is not claude, via `withoutClaudePromptSeparator`). Kingu passes an argv (no shell), so Orca's PowerShell quoting of `--` does not apply. Tests: `agentProfiles.test.ts`, `paneLaunch.test.ts`, `agentHooks.test.ts` |
| f124b4b5f `fix(native-chat): keep the launch effort when a terminal agent starts on its default model` | A `valuesWithoutModel` slot in the PTY session-option record (`shared/native-chat/input/session-options/*`) keeps the launch effort while the model is unknown | skipped: Kingu has no native chat over a terminal agent's PTY (no session-option record seeded from a launch); its chats' effort with the default model already comes from the agent's advertised levels (`agent/effortChoice.svelte.ts` `effortState`) |
| c6594b2c2 `fix(codex): summarize every file of one multi-file apply_patch in native chat` | A completed Codex `fileChange` of several files is saved as one `diff --git` section per file (whole-file hunks for add/delete, the `move_path` / `Moved to:` destination kept), not a headerless join (`main/codex/structured/items/codex-file-change-patch.ts`, `replacementHunk` in `provider-timeline-replacement-patch.ts`); one file, a patch past the wire head or a header-unsafe name keeps the plain join | **ported** (the patch): `apps/agent-host/src/runtimes/tools.ts` `codexFileChangePatch` (limit: `MAX_TOOL_RESULT_CHARS`), used for the Edit row's `diff`. The changed-files summary was already right in Kingu: it comes from the files snapshotted by path (`paths` of every change), not from the patch text, so Orca's "N files" count-path parsing (`native-chat-edit-patch-files.ts`) has no counterpart. Test: `apps/agent-host/test/runtimes.test.ts` |
| 08cc08354 `fix(antigravity): show a saved level model as its family and level` | `listedSelection` maps a saved level id (`gemini-4-neon-high`) onto its listed family row and effort (`main/acp/acp-dialects/antigravity-dialect.ts`) | skipped: Kingu lists Antigravity's models as the agent reports them, with no family/level grouping (`familyEfforts`), so a level id is never shown beside an effort |
| 431335402 `Keep Antigravity's full model list when agy models comes back short` | The account model catalog keeps rows seen before when `agy models` lists fewer (`main/native-chat/agent-model-catalog/agent-model-catalog-seen-rows.ts`), plus a Refresh models button | skipped: Kingu does not run `agy models` or keep an account model catalog; Antigravity's models come from its ACP session |
| bd67f1366 `fix(native-chat): show new Claude and Codex chats in the workspace sidebar before the first send` | A published chat with no status yet projects as an idle session-boundary row (`structured-agent-session-status-projection.ts`) | skipped: Kingu's workspace sidebar has no chat rows (its ADE tabs are agent terminals, `ade/adeTabs.ts`) |
| b5b84ae3d `fix(agent-hooks): save a pane's turn changes within a second` | Turn edges in the hook server's in-memory status map save within 1 s instead of the 3-minute batch (`main/agent-hooks/server/server-status-file.ts`, `status-restored-state.ts`) | **already equivalent**: Kingu keeps no in-memory status map to save; each hook appends to the pane's hook file at once (`agent-hook.sh`, `status_hooks.rs`) and a restart reads the file from offset 0 (`ade/paneAgents.svelte.ts` `agent_pane_hook_read`) |
| 8b956a69f `Use plain language when a chat cannot open` | AI vault / structured-session reveal failures: "This chat is still starting…" or "Couldn't open this chat." with Show details and Retry (`agent-session/open/chat-open-failure-toast.tsx`) | skipped: no counterpart; Kingu's chats are local to this app (no host reveal or AI-vault reopen) |
| 4b6677d11 `fix(native-chat): fill the resume toast's Resume button with the theme accent` | The Resume button uses a theme-accent fill and derived label (`theme-accent-button-tokens.ts`, `shared/color/accent-ink.ts`) | **already equivalent**: Kingu's resume row's Continue (`agent/ChatResumeNotice.svelte`) is filled with the theme's `--vscode-button-background` / `-foreground`, which every theme sets as its accent pair |
| aefd4db28 `fix(native-chat): wrap long URLs in comment bubbles` | Bot item comment bubbles (`native-chat/bot-items/NativeChatBotItemNoteRow.tsx`) | skipped: bots |
| c0cd8a81f `fix(agent-permissions): show permission descriptions as tooltips` | Permission dropdown rows become one line with the description as a side tooltip (`PermissionChoiceRadioItem.tsx`) | skipped: Kingu's agent permission choice (`settings/pages/AgentCatalog.svelte`) is a one-line segmented control with no description rows; the chat composer's picker follows VS Code |
| 28a6043af `Show other agents' waiting messages at the end of the chat` | Agent mail from other orchestrated agents drawn after the transcript instead of in the queue (mostly `mobile/`) | skipped: Kingu's chats have no agent-mail queue; mobile is not built |
| 925bcc7ec `fix(native-chat): drop the question card's step bar` | The multi-question card loses its segment bar; count and arrows stay | **already equivalent**: Kingu's question cards (`agent/QuestionCard.svelte`, `ade/CliQuestion.svelte`) have no step bar |
| 0edcb65de `perf(journal): a window of a chat's newest turns reads only the sends it can hold` | SQL journal window reads for bot requests (`journal-operation-window-sends.ts`) | skipped: Kingu has no journal database (bots/Slack) |

## Orca browser, agent install, system services and chrome round (checked 2026-11-24, Orca after 7ebb8cfbd)

Twenty-two Orca commits on the browser, Settings › Agents installs, background services and the
workbench chrome, read in `/Users/bright/src-ref/orca` (`git show <sha>`). What maps:

| Orca commit | What it does | Kingu |
|---|---|---|
| 4a4cbdfc9 `Make Import Cookies profiles searchable` | Import Cookies… opens one search picker instead of three menus deep: a Last used row (empty search only, kept in `localStorage`, dropped when that browser or profile is gone), one section per detected browser (a one-profile browser is a single row named after it, its section unlabeled), From File…, and the "Google logins aren't imported" note; every typed word must appear in "<browser> <profile>" (`browser-pane/assemble-chrome/profile-routing/browser-cookie-import-picker-rows.ts`, `browser-cookie-import-last-used.ts`, `browser-cookie-import-picker.tsx`) | **ported**: `src/lib/ade/cookieImport.ts` (`cookiePickRows`, `cookiePickSource`, `readCookieImportLastUsed`, `rememberCookieImportLastUsed`, key `kingu.browser.cookieImport.lastUsedSource`), `src/lib/ade/AdeBrowser.svelte` (`importCookies` is a Quick Input with `dynamic` rows). Quick Input hides group labels while searching, so a matching profile row then names its browser beside it; with no match the From File… row says "No matching profiles". A browser that listed no profiles imports with no profile (`directory: null`, as Orca's `profile: null`). Strings `ade.cookieImport.search`, `.lastUsed`, `.noMatches` (en, th); the unused `.pick` / `.from` went. Test: `cookieImport.test.ts` |
| fd60d2198 `feat(browser): clear cookies for one profile on any Settings host, including SSH hosts` | Clear cookies… for the active profile after a confirmation ("Clear cookies in {profile} on this computer?", "signs you out of every site in this profile. Other profiles and hosts keep their cookies."); main derives the jar from a bounded profile id, never a partition (`main/ipc/browser/browser-cookie-clear-ipc.ts`, `browserSessionRegistry.clearProfileSessionCookies`); paired-server and SSH-host jars | **ported for this computer**: command `browser_cookie_clear` (`src-tauri/src/floating_browser/cookies.rs`: `webkit::clear_all` deletes every cookie in the profile's `WKWebsiteDataStore`, chosen by `profile_store` as for its tabs; a profile name over 256 bytes is refused), and `session_cookies::forget` drops the profile's sealed session-cookie snapshot so a restart can't restore them. Kingu has no Settings › Browser page; the action sits in the tab's profile picker (`AdeBrowser.svelte` `pickProfile` › Clear Cookies…, `clearCookies`), for that tab's profile. Strings `ade.cookieClear.*` (en, th). Skipped: paired-server stores (no paired servers) and SSH-host jars (Kingu keeps no per-host cookie store; a page reached through an SSH host uses its tab's profile) |
| 538468930 `Restored browser tabs load after a restart when an extension is installed` | Defers a restored page's attach until its Chromium extension session is ready (`browser-extension-session-presence.ts`, `browser-page-deferred-attach.ts`) | skipped: Kingu's browser (WebKit) loads no browser extensions |
| 526e4e6f1 `fix(browser): a failed link open in Orca's browser says why` | A failed open in a paired host's workspace browser adds one short cause line ("Error · create · invalid_argument", "Workspace's computer wasn't found.") from host error codes, never the URL (`lib/browser/workspace/workspace-browser-tab-presentation.ts`, `runtime-rpc-error-code.ts`) | **already equivalent** locally: Kingu opens every tab on this computer (`BrowserSurface.svelte`), and a failed `floating_browser_open` already shows its own error (`status.error`); the host-stage codes are paired-server only |
| 4f56f7c0e `fix(settings): keep chat runtime install progress readable` | The Settings install row: unpacking and verifying say "Unpacking…" / "Verifying…" with a spinner (a screen reader hears "Unpacking {agent}…" / "Verifying {agent}…"); only a known, positive size gives a percent, otherwise the download spins too; a status that explains a problem (unavailable, damaged, outdated), counts a download or says Not installed wraps whole, the rest truncate; the bar starts small (`basis-16`) and grows to `max-w-44` so Cancel fits beside it; Cancel never shrinks; the user's own copy reads "Uses your own copy" (heard "Uses your own {agent}") and hides a failed install of Orca's copy (a failed Remove still shows); the chat card's check step reads "Verifying {agent}…" (`components/managed-runtime/managed-runtime-install-view.ts`, `ManagedRuntimeInstallRow.tsx`, `managed-runtime-install-card.ts`) | **ported**: `src/lib/agent/managedCli.ts` (`settingsView`: `spokenStatus`, `busy`, `wraps`; `installCard` check detail), `src/lib/agent/ManagedCliRow.svelte`, strings `managedCli.extractingShort`, `.verifyingAgent`, `.externalShort` and the changed `.extracting`, `.verifying`, `.external`, `.checkingDetail` (en, th). Test: `managedCli.test.ts` |
| 1a9651f51 `fix(settings): keep revealed agent controls clear of the page edge, keep the Installed heading on Choose per agent, name chevrons after their agent` | Each agent row's details chevron is labelled "Show/Hide {agent} details" (`settings/agents/launch/AgentRowDetailsToggle.tsx`); a 24px reveal padding (`settings-list-scroll.ts`) and "Choose per agent" landing on a pickable Chat/CLI choice (`installed-agent-choice-reveal.ts`) | **ported** (the chevron): `src/lib/settings/pages/AgentCatalog.svelte`, aria-label "Customize {agent} command" / "Hide {agent} command" (`settings.agents.customizeAgent`, `.hideAgentCommand`, en, th). Skipped: Kingu's Settings › Agents has no Choose per agent / default surface section and opens a row without scrolling it |
| 5d34df718 `Check agent CLI updates after launch settles, a few at a time` | At most three `--version` probes run at once (`versionReads = new PrioritySemaphore(3)` in `main/agent-cli-update/agent-cli-update-service.ts`), the launch check waits 15 s, and a failed check may retry before the interval | **ported** (the probe limit): `src-tauri/src/agent/runtimes.rs` `read_version` passes a counting `Gate` of `VERSION_PROBES = 3`, so chats resumed or started together never run more than three agent runtimes for a version. Skipped: Kingu has no agent CLI update service to delay (versions are read only as a chat starts). Test: `runtimes::tests::at_most_three_version_probes_run_at_once` |
| 70a1f42a3 `Clean up leftover plugin git temp folders` | A quit, crash or kill mid-fetch left ~230 MB clones in the temp folder; 30 s after start-up, plugin git temp folders older than an hour are removed in the background, and will-quit aborts running plugin git (`main/plugins/installation/plugin-git-temp-sweep.ts`, `plugin-git-repository.ts` `abortPluginGitForShutdown`, `startup/quit/main-process-quit.ts`) | **ported** for Snaps and skills (Kingu's plugins): `src-tauri/src/snap_install.rs` `sweep_stale_staging` (30 s after setup, `snap-staging` and `skill-staging` folders older than `STAGING_TTL`, an hour; before, they were pruned only when the next install began) and `stop_git_for_shutdown` (a static flag every Snap/skill `clone` and `fetch_commit` passes to `git_remote::net_env` as its cancel, set on `RunEvent::Exit` in `lib.rs`, so the running git is killed). Test: `snap_install::tests::the_staging_sweep_removes_only_folders_older_than_an_hour` |
| 30a0b6f59 `fix(cli): save downloads beside an older file of the same name instead of refusing` | `orca slack` / Google file downloads number past an existing name (`src/cli/slack/slack-action-files.ts`) | skipped: Slack and Google CLIs are not built. Kingu's browser downloads already never overwrite (`floating_browser.rs` `download_path`: "name (2).ext") |
| 2af98f825 `Move the Linux port scan's per-file process lookup off Orca's main process` | Reads `/proc/<pid>/fd` socket owners in the port-scan worker (`main/ports/linux-socket-owners.ts`) | **already equivalent**: Kingu's port scan runs `lsof` on a blocking thread (`system.rs` `ports`, called through `blocking` in `lib.rs`), never walking `/proc` fds in the app's main thread |
| 50284224e `fix(watchers): rewatch a local root after the watcher crash fuse cools down` | Parcel watcher child-process crash fuse (`filesystem-watcher-local-*.ts`) | skipped: Kingu's watchers (`watcher.rs`) are in-process `notify` (FSEvents) with no child process or crash fuse |
| de4b047b7 `fix(tabs): raise active tab contrast` | Orca's own tab tokens: dark `--tab-active` mixes up to 11% foreground, light `--tab-inactive` up to 8%, as deep as keeps tab text readable (`app-shell/appearance/tab-contrast-mix.ts`, `assets/main.css`) | skipped: Kingu's tabs (ADE `ade/AdeTabBar.svelte`, IDE editor tabs) are painted by the VS Code color theme's `tab.activeBackground` / `tab.inactiveBackground`, which the IDE must keep as VS Code does |
| 18b386edc, f344d833f, c363299cd | App rail button spacing (10px gap, 40px rhythm) and rail destinations filling the page (`components/app-rail/*`, `app-shell/chrome/AppShellLeftColumn.tsx`) | skipped: Kingu has no app rail |
| 82c7e4e2d, aca315dc6, 6627dcf5f, da483aed4, 12adf3169, 84acc5b85 | Save to this computer for downloads and Print from streamed pages, moving a tab between this computer and a paired server, server tabs shown twice after relaunch, forwarding a paired server's ports | skipped: Orca's paired server ("Server" streamed pages, paired ports); Kingu has none |
| ab57a1cb2 `fix(keep-awake): cancel pending WSL inventory connections` | WSL host keep-awake | skipped: WSL |

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
