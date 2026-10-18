<script lang="ts" module>
	import {
		ArrowClockwiseIcon,
		ArrowCounterClockwiseIcon,
		ArrowLeftIcon,
		ArrowRightIcon,
		ArrowSquareOutIcon,
		ArrowUpIcon,
		ArrowBendUpRightIcon,
		ArrowLineDownIcon,
		ArrowLineUpIcon,
		ArrowsInLineVerticalIcon,
		BellIcon,
		BugIcon,
		CaretDownIcon,
		CaretRightIcon,
		CaretUpIcon,
		CheckIcon,
		CircleIcon,
		ChecksIcon,
		CodeIcon,
		CopyIcon,
		CpuIcon,
		CoffeeIcon,
		FileIcon,
		FileMagnifyingGlassIcon,
		FilePlusIcon,
		FilesIcon,
		FolderIcon,
		FolderPlusIcon,
		GearSixIcon,
		GitBranchIcon,
		GitCommitIcon,
		GitMergeIcon,
		GitPullRequestIcon,
		InfoIcon,
		KanbanIcon,
		LayoutIcon,
		ListIcon,
		MagnifyingGlassIcon,
		MemoryIcon,
		MinusIcon,
		PauseIcon,
		PlayIcon,
		PlugIcon,
		PlusIcon,
		ProhibitIcon,
		SidebarSimpleIcon,
		SquaresFourIcon,
		SquareSplitVerticalIcon,
		StopCircleIcon,
		StopIcon,
		SwapIcon,
		TerminalWindowIcon,
		TrashIcon,
		UserCircleIcon,
		WarningIcon,
		XCircleIcon,
		XIcon
	} from 'phosphor-svelte';
	import ArkaiMark from './ArkaiMark.svelte';
	import KinguMark from './KinguMark.svelte';

	// Phosphor glyphs, plus Kingu's two brand marks: `kingu` (app) and `agent` (Arkai, our AI).
	export const icons = {
		files: FilesIcon,
		search: MagnifyingGlassIcon,
		git: GitBranchIcon,
		agent: ArkaiMark,
		settings: GearSixIcon,
		account: UserCircleIcon,
		chevronRight: CaretRightIcon,
		arrowLeft: ArrowLeftIcon,
		arrowRight: ArrowRightIcon,
		chevronDown: CaretDownIcon,
		close: XIcon,
		sidebarLeft: SidebarSimpleIcon,
		panelBottom: SquareSplitVerticalIcon,
		sidebarRight: SidebarSimpleIcon,
		branch: GitBranchIcon,
		error: XCircleIcon,
		bug: BugIcon,
		bell: BellIcon,
		warning: WarningIcon,
		info: InfoIcon,
		folder: FolderIcon,
		file: FileIcon,
		plus: PlusIcon,
		minus: MinusIcon,
		/** Git-ignored, in file trees (Orca's ⊘). */
		ignored: ProhibitIcon,
		discard: ArrowCounterClockwiseIcon,
		goToFile: FileMagnifyingGlassIcon,
		check: CheckIcon,
		send: ArrowUpIcon,
		chevronUp: CaretUpIcon,
		newFile: FilePlusIcon,
		newFolder: FolderPlusIcon,
		collapseAll: ArrowsInLineVerticalIcon,
		replace: SwapIcon,
		tasks: KanbanIcon,
		trash: TrashIcon,
		play: PlayIcon,
		stop: StopIcon,
		merge: GitMergeIcon,
		pullRequest: GitPullRequestIcon,
		refresh: ArrowClockwiseIcon,
		kingu: KinguMark,
		menu: ListIcon,
		layout: LayoutIcon,
		code: CodeIcon,
		/** The Agents layout (Open in Agents); `code` is its way back to the editor. */
		agentsLayout: SquaresFourIcon,
		terminal: TerminalWindowIcon,
		coffee: CoffeeIcon,
		memory: MemoryIcon,
		cpu: CpuIcon,
		ports: PlugIcon,
		copy: CopyIcon,
		openExternal: ArrowSquareOutIcon,
		stopProcess: StopCircleIcon,
		commit: GitCommitIcon,
		replaceAll: ChecksIcon,
		pause: PauseIcon,
		stepOver: ArrowBendUpRightIcon,
		stepInto: ArrowLineDownIcon,
		stepOut: ArrowLineUpIcon,
		breakpoint: CircleIcon
	} as const;
	export type IconName = keyof typeof icons;

	const BRAND = new Set<IconName>(['agent', 'kingu']);
</script>

<script lang="ts">
	/** `filled` swaps in the solid glyph: use it for the on state of toggles and the active view. */
	let { name, size = 16, filled = false }: { name: IconName; size?: number; filled?: boolean } = $props();

	const Glyph = $derived(icons[name]);
	// Keeps the rendered stroke near 1.5px: bold at UI sizes, regular for large empty-state icons.
	const weight = $derived(filled ? 'fill' : size > 18 ? 'regular' : 'bold');
</script>

{#if BRAND.has(name)}
	<Glyph {size} class="shrink-0" />
{:else}
	<!-- Flipped with CSS: Phosphor's `mirrored` sets a transform attribute that WKWebView ignores on <svg> -->
	<Glyph {size} {weight} class={name === 'sidebarRight' ? 'shrink-0 -scale-x-100' : 'shrink-0'} aria-hidden="true" />
{/if}
