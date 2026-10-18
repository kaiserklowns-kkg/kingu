// VS Code settings: git.* (the built-in Git extension). Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const GIT_SETTINGS: SettingSchema[] = [
	{
		id: 'git.enabled',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'เปิดใช้ Git ใน Kingu ปิดแล้วจะไม่รันคำสั่ง git เลย (Whether Git is enabled.)'
	},
	{
		id: 'git.path',
		group: 'Git',
		type: 'json',
		schema: { type: ['string', 'null', 'array'] },
		default: null,
		description: 'path ของโปรแกรม git หรือรายการ path ที่ลองตามลำดับ เว้นว่างเพื่อใช้ git จาก PATH (Path and filename of the git executable, e.g. `C:\\Program Files\\Git\\bin\\git.exe` (Windows). This can also be an array of string values containing multiple paths to look up.)',
		scope: 'application'
	},
	{
		id: 'git.autorefresh',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'อ่านสถานะ git ใหม่อัตโนมัติเมื่อกลับมาที่หน้าต่างหรือบันทึกไฟล์ (Whether auto refreshing is enabled.)'
	},
	{
		id: 'git.autofetch',
		group: 'Git',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, false, 'all'] },
		default: false,
		description: 'fetch จาก remote เป็นระยะ ค่า all จะ fetch ทุก remote (When set to true, commits will automatically be fetched from the default remote of the current Git repository. Setting to `all` will fetch from all remotes.)'
	},
	{
		id: 'git.autofetchPeriod',
		group: 'Git',
		type: 'number',
		default: 180,
		description: 'ระยะห่างเป็นวินาทีระหว่างการ fetch อัตโนมัติ (Duration in seconds between each automatic git fetch, when `#git.autofetch#` is enabled.)'
	},
	{
		id: 'git.defaultBranchName',
		group: 'Git',
		type: 'string',
		default: 'main',
		description: 'ชื่อ branch เริ่มต้นเมื่อสร้าง repository ใหม่ (The name of the default branch (example: main, trunk, development) when initializing a new Git repository. When set to empty, the default branch name configured in Git will be used. **Note:** Requires Git version `2.28.0` or later.)'
	},
	{
		id: 'git.branchPrefix',
		group: 'Git',
		type: 'string',
		default: '',
		description: 'คำนำหน้าที่เติมให้ชื่อ branch ใหม่ (Prefix used when creating a new branch.)'
	},
	{
		id: 'git.branchProtection',
		group: 'Git',
		type: 'array',
		items: 'string',
		default: [],
		description: 'รายการ branch ที่ป้องกันไว้ ใช้ glob ได้ จะถามก่อน commit ลง branch เหล่านี้ (List of protected branches. By default, a prompt is shown before changes are committed to a protected branch. The prompt can be controlled using the `#git.branchProtectionPrompt#`  setting.)'
	},
	{
		id: 'git.branchProtectionPrompt',
		group: 'Git',
		type: 'string',
		default: 'alwaysPrompt',
		enum: ['alwaysCommit', 'alwaysCommitToNewBranch', 'alwaysPrompt'],
		enumDescriptions: [
			'commit ลง branch ที่ป้องกันไว้เลย (Always commit changes to the protected branch.)',
			'commit ลง branch ใหม่เสมอ (Always commit changes to a new branch.)',
			'ถามทุกครั้ง (Always prompt before changes are committed to a protected branch.)'
		],
		description: 'สิ่งที่ทำเมื่อ commit ลง branch ที่ป้องกันไว้ (Controls whether a prompt is being shown before changes are committed to a protected branch.)'
	},
	{
		id: 'git.branchValidationRegex',
		group: 'Git',
		type: 'string',
		default: '',
		description: 'regular expression ที่ชื่อ branch ใหม่ต้องตรง (A regular expression to validate new branch names.)'
	},
	{
		id: 'git.branchWhitespaceChar',
		group: 'Git',
		type: 'string',
		default: '-',
		description: 'ตัวอักษรที่ใช้แทนช่องว่างในชื่อ branch ใหม่และคั่นคำของชื่อสุ่ม (The character to replace whitespace in new branch names, and to separate segments of a randomly generated branch name.)'
	},
	{
		id: 'git.branchRandomName.enable',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'สุ่มชื่อ branch ให้เมื่อสร้าง branch ใหม่ กด Enter โดยไม่พิมพ์เพื่อใช้ชื่อสุ่ม (Controls whether a random name is generated when creating a new branch.)'
	},
	{
		id: 'git.branchRandomName.dictionary',
		group: 'Git',
		type: 'json',
		schema: {
			type: 'array',
			minItems: 1,
			maxItems: 5,
			items: { type: 'string', enum: ['adjectives', 'animals', 'colors', 'numbers'] }
		},
		default: ['adjectives', 'animals'],
		description: 'ชุดคำที่ใช้สุ่มชื่อ branch ทีละคำตามลำดับ (List of dictionaries used for the randomly generated branch name. Each value represents the dictionary used to generate the segment of the branch name. Supported dictionaries: `adjectives`, `animals`, `colors` and `numbers`.)'
	},
	{
		id: 'git.confirmSync',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'ถามก่อน sync (Confirm before synchronizing Git repositories.)'
	},
	{
		id: 'git.countBadge',
		group: 'Git',
		type: 'string',
		default: 'all',
		enum: ['all', 'tracked', 'off'],
		enumDescriptions: [
			'นับทุกการเปลี่ยนแปลง (Count all changes.)',
			'นับเฉพาะไฟล์ที่ track อยู่ (Count only tracked changes.)',
			'ไม่แสดงตัวเลข (Turn off counter.)'
		],
		description: 'สิ่งที่นับในตัวเลขของ Git บนไอคอน Source Control (Controls the Git count badge.)'
	},
	{
		id: 'git.checkoutType',
		group: 'Git',
		type: 'json',
		schema: { type: 'array', items: { type: 'string', enum: ['local', 'tags', 'remote'] } },
		default: ['local', 'remote', 'tags'],
		description: 'ชนิดของ ref ที่แสดงใน Checkout to... ตามลำดับ (Controls what type of Git refs are listed when running `Checkout to...`.)'
	},
	{
		id: 'git.ignoreLimitWarning',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ไม่ต้องเตือนเมื่อมีการเปลี่ยนแปลงเกิน git.statusLimit (Ignores the warning when there are too many changes in a repository.)'
	},
	{
		id: 'git.defaultCloneDirectory',
		group: 'Git',
		type: 'json',
		schema: { type: ['string', 'null'] },
		default: null,
		description: 'โฟลเดอร์เริ่มต้นที่จะ clone repository ไปเก็บ (The default location to clone a Git repository.)',
		scope: 'application'
	},
	{
		id: 'git.enableSmartCommit',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'commit การเปลี่ยนแปลงทั้งหมดเมื่อยังไม่มีไฟล์ที่ stage (Commit all changes when there are no staged changes.)'
	},
	{
		id: 'git.smartCommitChanges',
		group: 'Git',
		type: 'string',
		default: 'all',
		enum: ['all', 'tracked'],
		enumDescriptions: [
			'stage ทุกการเปลี่ยนแปลง (Automatically stage all changes.)',
			'stage เฉพาะไฟล์ที่ git track อยู่ (Automatically stage tracked changes only.)'
		],
		description: 'สิ่งที่ smart commit stage ให้ (Control which changes are automatically staged by Smart Commit.)'
	},
	{
		id: 'git.suggestSmartCommit',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'เสนอให้เปิด smart commit เมื่อ commit โดยยังไม่มีไฟล์ที่ stage (Suggests to enable smart commit (commit all changes when there are no staged changes).)'
	},
	{
		id: 'git.enableCommitSigning',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'เซ็น commit ด้วย GPG, X.509 หรือ SSH ตามที่ตั้งไว้ใน git (Enables commit signing with GPG, X.509, or SSH.)'
	},
	{
		id: 'git.confirmEmptyCommits',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'ถามก่อนสร้าง commit ว่างด้วยคำสั่ง Git: Commit Empty (Always confirm the creation of empty commits for the \'Git: Commit Empty\' command.)'
	},
	{
		id: 'git.decorations.enabled',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดงสีและตัวอักษรสถานะ git ใน Explorer (Controls whether Git contributes colors and badges to the Explorer and the Open Editors view.)'
	},
	{
		id: 'git.enableStatusBarSync',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่ม Sync ใน status bar (Controls whether the Git Sync command appears in the status bar.)'
	},
	{
		id: 'git.followTagsWhenSync',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'push annotated tag ไปด้วยเมื่อ sync (Push all annotated tags when running the sync command.)'
	},
	{
		id: 'git.replaceTagsWhenPull',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ใช้ tag ของ remote แทน tag ในเครื่องเมื่อขัดกันตอน pull (Automatically replace the local tags with the remote tags in case of a conflict when running the pull command.)'
	},
	{
		id: 'git.promptToSaveFilesBeforeStash',
		group: 'Git',
		type: 'string',
		default: 'always',
		enum: ['always', 'staged', 'never'],
		enumDescriptions: [
			'ถามเมื่อมีไฟล์ใดยังไม่บันทึก (Check for any unsaved files.)',
			'ถามเฉพาะไฟล์ที่ stage แล้ว (Check only for unsaved staged files.)',
			'ไม่ถาม (Disable this check.)'
		],
		description: 'ถามให้บันทึกไฟล์ที่ยังไม่บันทึกก่อน stash (Controls whether Git should check for unsaved files before stashing changes.)'
	},
	{
		id: 'git.promptToSaveFilesBeforeCommit',
		group: 'Git',
		type: 'string',
		default: 'always',
		enum: ['always', 'staged', 'never'],
		enumDescriptions: [
			'ถามเมื่อมีไฟล์ใดยังไม่บันทึก (Check for any unsaved files.)',
			'ถามเฉพาะไฟล์ที่ stage แล้ว (Check only for unsaved staged files.)',
			'ไม่ถาม (Disable this check.)'
		],
		description: 'ถามให้บันทึกไฟล์ที่ยังไม่บันทึกก่อน commit (Controls whether Git should check for unsaved files before committing.)'
	},
	{
		id: 'git.postCommitCommand',
		group: 'Git',
		type: 'string',
		default: 'none',
		enum: ['none', 'push', 'sync'],
		enumDescriptions: [
			'ไม่รันอะไร (Don\'t run any command after a commit.)',
			'push หลัง commit (Run \'git push\' after a successful commit.)',
			'pull แล้ว push หลัง commit (Run \'git pull\' and \'git push\' after a successful commit.)'
		],
		description: 'คำสั่งที่รันต่อหลัง commit สำเร็จ (Run a git command after a successful commit.)'
	},
	{
		id: 'git.openAfterClone',
		group: 'Git',
		type: 'string',
		default: 'prompt',
		enum: ['always', 'alwaysNewWindow', 'whenNoFolderOpen', 'prompt'],
		enumDescriptions: [
			'เปิดเสมอ (Always open in current window.)',
			'เปิดเสมอ ในหน้าต่างนี้เพราะ Kingu มีหน้าต่างเดียว (Always open in a new window.)',
			'เปิดเมื่อยังไม่ได้เปิดโฟลเดอร์ใด (Only open in current window when no folder is opened.)',
			'ถามทุกครั้ง (Always prompt for action.)'
		],
		description: 'เปิด repository ที่ clone มาเลยหรือไม่ Kingu มีหน้าต่างเดียว ค่า alwaysNewWindow จึงเปิดในหน้าต่างนี้ (Controls whether to open a repository automatically after cloning.)'
	},
	{
		id: 'git.showInlineOpenFileAction',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่ม Open File ที่แต่ละไฟล์ใน Source Control (Controls whether to show an inline Open File action in the Git changes view.)'
	},
	{
		id: 'git.showPushSuccessNotification',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'แจ้งเตือนเมื่อ push สำเร็จ (Controls whether to show a notification when a push is successful.)'
	},
	{
		id: 'git.inputValidation',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'เตือนเมื่อข้อความ commit ยาวเกินกำหนด (Controls whether to show commit message input validation diagnostics.)'
	},
	{
		id: 'git.inputValidationLength',
		group: 'Git',
		type: 'number',
		default: 72,
		description: 'ความยาวบรรทัดของข้อความ commit ที่เริ่มเตือน (Controls the commit message length threshold for showing a warning.)'
	},
	{
		id: 'git.inputValidationSubjectLength',
		group: 'Git',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: 50,
		description: 'ความยาวบรรทัดแรกของข้อความ commit ที่เริ่มเตือน ค่า null ใช้ git.inputValidationLength (Controls the commit message subject length threshold for showing a warning. Unset it to inherit the value of `#git.inputValidationLength#`.)'
	},
	{
		id: 'git.alwaysShowStagedChangesResourceGroup',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'แสดงกลุ่ม Staged Changes เสมอแม้ไม่มีไฟล์ (Always show the Staged Changes resource group.)'
	},
	{
		id: 'git.alwaysSignOff',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'เติม Signed-off-by ให้ทุก commit (Controls the signoff flag for all commits.)'
	},
	{
		id: 'git.ignoreSubmodules',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ไม่แสดงการเปลี่ยนแปลงใน submodule (Ignore modifications to submodules in the file tree.)'
	},
	{
		id: 'git.showProgress',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดงความคืบหน้าของคำสั่ง git ใน status bar (Controls whether Git actions should show progress.)'
	},
	{
		id: 'git.rebaseWhenSync',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ใช้ rebase เมื่อ sync (Force Git to use rebase when running the sync command.)'
	},
	{
		id: 'git.pullBeforeCheckout',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'fast-forward branch ที่ไม่มี commit ค้าง push ก่อน checkout (Controls whether a branch that does not have outgoing commits is fast-forwarded before it is checked out.)'
	},
	{
		id: 'git.fetchOnPull',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'fetch ทุก remote และทุก branch เมื่อ pull (When enabled, fetch all branches when pulling. Otherwise, fetch just the current one.)'
	},
	{
		id: 'git.pruneOnFetch',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ลบ remote branch ที่ไม่มีแล้วเมื่อ fetch (Prune when fetching.)'
	},
	{
		id: 'git.pullTags',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'fetch tag ทั้งหมดเมื่อ pull (Fetch all tags when pulling.)'
	},
	{
		id: 'git.autoStash',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'stash การแก้ไขก่อน pull แล้วนำกลับมาหลัง pull สำเร็จ (Stash any changes before pulling and restore them after successful pull.)'
	},
	{
		id: 'git.allowForcePush',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'เปิดคำสั่ง Git: Push Force (Controls whether force push (with or without lease) is enabled.)'
	},
	{
		id: 'git.useForcePushWithLease',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'force push แบบปลอดภัยด้วย force-with-lease (Controls whether force pushing uses the safer force-with-lease variant.)'
	},
	{
		id: 'git.useForcePushIfIncludes',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'force push แบบปลอดภัยด้วย force-if-includes ต้องเปิด git.useForcePushWithLease ด้วย (Controls whether force pushing uses the safer force-if-includes variant. Note: This setting requires the `#git.useForcePushWithLease#` setting to be enabled, and Git version `2.30.0` or later.)'
	},
	{
		id: 'git.confirmForcePush',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'ถามก่อน force push (Controls whether to ask for confirmation before force-pushing.)'
	},
	{
		id: 'git.allowNoVerifyCommit',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'เปิดคำสั่ง Git: Commit No Verify ที่ข้าม pre-commit และ commit-msg hook (Controls whether commits without running pre-commit and commit-msg hooks are allowed.)'
	},
	{
		id: 'git.confirmNoVerifyCommit',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'ถามก่อน commit โดยข้าม hook (Controls whether to ask for confirmation before committing without verification.)'
	},
	{
		id: 'git.closeDiffOnOperation',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ปิด diff editor เองเมื่อ stash, commit, discard, stage หรือ unstage ไฟล์นั้น (Controls whether the diff editor should be automatically closed when changes are stashed, committed, discarded, staged, or unstaged.)'
	},
	{
		id: 'git.openDiffOnClick',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'คลิกไฟล์ใน Source Control แล้วเปิด diff ถ้าปิดจะเปิดไฟล์ตามปกติ (Controls whether the diff editor should be opened when clicking a change. Otherwise the regular editor will be opened.)'
	},
	{
		id: 'git.branchSortOrder',
		group: 'Git',
		type: 'string',
		default: 'committerdate',
		enum: ['committerdate', 'alphabetically'],
		enumDescriptions: ['เรียงตามวันที่ commit ใหม่สุดก่อน', 'เรียงตามชื่อ'],
		description: 'การเรียง branch ใน Checkout to... (Controls the sort order for branches.)'
	},
	{
		id: 'git.untrackedChanges',
		group: 'Git',
		type: 'string',
		default: 'mixed',
		enum: ['mixed', 'separate', 'hidden'],
		enumDescriptions: [
			'แสดงรวมกับ Changes (All changes, tracked and untracked, appear together and behave equally.)',
			'แสดงในกลุ่ม Untracked Changes ของตัวเอง (Untracked changes appear separately in the Source Control view. They are also excluded from several actions.)',
			'ไม่แสดงและไม่ถูก commit (Untracked changes are hidden and excluded from several actions.)'
		],
		description: 'การแสดงไฟล์ที่ยังไม่ track (Controls how untracked changes behave.)'
	},
	{
		id: 'git.requireGitUserConfig',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'ต้องตั้ง user.name และ user.email ของ git ก่อน commit (Controls whether to require explicit Git user configuration or allow Git to guess if missing.)'
	},
	{
		id: 'git.showCommitInput',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดงช่องข้อความ commit ใน Source Control (Controls whether to show the commit input in the Git source control panel.)'
	},
	{
		id: 'git.useCommitInputAsStashMessage',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ใช้ข้อความในช่อง commit เป็นข้อความ stash เมื่อไม่ได้พิมพ์ (Controls whether to use the message from the commit input box as the default stash message.)'
	},
	{
		id: 'git.showActionButton',
		group: 'Git',
		type: 'json',
		schema: {
			type: 'object',
			properties: { commit: { type: 'boolean' }, publish: { type: 'boolean' }, sync: { type: 'boolean' } },
			additionalProperties: false
		},
		default: { commit: true, publish: true, sync: true },
		description: 'ปุ่มที่แสดงใต้ช่องข้อความ commit ได้แก่ Commit, Publish Branch และ Sync Changes (Controls whether an action button is shown in the Source Control view.)'
	},
	{
		id: 'git.statusLimit',
		group: 'Git',
		type: 'number',
		default: 10000,
		description: 'จำนวนการเปลี่ยนแปลงสูงสุดที่แสดง 0 คือไม่จำกัด (Controls how to limit the number of changes that can be parsed from Git status command. Can be set to 0 for no limit.)'
	},
	{
		id: 'git.similarityThreshold',
		group: 'Git',
		type: 'number',
		default: 50,
		minimum: 0,
		maximum: 100,
		description: 'เกณฑ์ความเหมือนเป็นเปอร์เซ็นต์ที่ถือว่าไฟล์ถูกเปลี่ยนชื่อ (Controls the threshold of the similarity index (the amount of additions/deletions compared to the file\'s size) for changes in a pair of added/deleted files to be considered a rename. **Note:** Requires Git version `2.18.0` or later.)'
	},
	{
		id: 'git.commitShortHashLength',
		group: 'Git',
		type: 'number',
		default: 7,
		minimum: 7,
		maximum: 40,
		description: 'ความยาว hash แบบสั้นของ commit (Controls the length of the commit short hash.)'
	},
	{
		id: 'git.diagnosticsCommitHook.enabled',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'ตรวจปัญหาจาก language server ในไฟล์ที่จะ commit ก่อน commit (Controls whether to check for unresolved diagnostics before committing.)'
	},
	{
		id: 'git.diagnosticsCommitHook.sources',
		group: 'Git',
		type: 'json',
		schema: {
			type: 'object',
			additionalProperties: { type: 'string', enum: ['error', 'warning', 'information', 'hint', 'none'] }
		},
		default: { '*': 'error' },
		description: 'แหล่งของปัญหาและความรุนแรงต่ำสุดที่ทำให้ถามก่อน commit (Controls the list of sources (**Item**) and the minimum severity (**Value**) to be considered before committing. **Note:** To ignore diagnostics from a particular source, add the source to the list and set the minimum severity to `none`.)'
	},
	{
		id: 'git.discardUntrackedChangesToTrash',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'ย้ายไฟล์ที่ยังไม่ track ไปถังขยะแทนการลบถาวรเมื่อ discard (Controls whether discarding untracked changes moves the file(s) to the Recycle Bin (Windows), Trash (macOS, Linux) instead of deleting them permanently. **Note:** This setting has no effect when connected to a remote or when running in Linux as a snap package.)'
	},
	{
		id: 'git.showReferenceDetails',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'แสดง commit ล่าสุดของแต่ละ ref ในตัวเลือก branch (Controls whether to show the details of the last commit for Git refs in the checkout, branch, and tag pickers.)'
	}
];
