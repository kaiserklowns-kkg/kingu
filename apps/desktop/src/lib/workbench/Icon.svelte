<script lang="ts" module>
	// Kingu's own stroke icons (24×24). VS Code's codicons are not reused.
	export const icons = {
		files: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5',
		search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8',
		git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
		agent: 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z',
		settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
		account: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
		chevronRight: 'M9 6l6 6-6 6',
		chevronDown: 'M6 9l6 6 6-6',
		close: 'M6 6l12 12M18 6L6 18',
		sidebarLeft: 'M3 4h18v16H3zM9 4v16',
		panelBottom: 'M3 4h18v16H3zM3 14h18',
		sidebarRight: 'M3 4h18v16H3zM15 4v16',
		branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
		error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
		warning: 'M12 3l10 18H2zM12 10v4M12 17h.01',
		info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
		folder: 'M3 6h6l2 2h10v11H3z',
		file: 'M14 3H6v18h12V7zM14 3v4h4',
		plus: 'M12 5v14M5 12h14',
		minus: 'M5 12h14',
		discard: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
		goToFile: 'M14 3H6v18h12V7zM14 3v4h4M9 14h6M13 11.5l2.5 2.5-2.5 2.5',
		check: 'M5 12.5l4.5 4.5L19 7.5',
		replace: 'M4 4h7v6H4zM13 14h7v6h-7zM14 4h2.5A2.5 2.5 0 0 1 19 6.5V11M17 9l2 2 2-2M10 20H7.5A2.5 2.5 0 0 1 5 17.5V13',
		tasks: 'M4 4h5v16H4zM10.5 4h5v10h-5zM17 4h3v7h-3z',
		trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
		play: 'M7 4l13 8-13 8z',
		stop: 'M6 6h12v12H6z',
		merge: 'M6 3v18M6 9a6 6 0 0 0 6 6h3M18 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
		pullRequest: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9v12M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 15V8a2 2 0 0 0-2-2h-4M14 3l-2 3 2 3',
		refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
		replaceAll:'M3 4h6v5H3zM3 13h6v5H3zM14 9h7v6h-7zM9 6.5h2.5a2 2 0 0 1 2 2V9M9 15.5h2.5a2 2 0 0 0 2-2V15'
	} as const;
	export type IconName = keyof typeof icons;
</script>

<script lang="ts">
	let { name, size = 16, stroke = 1.6 }: { name: IconName; size?: number; stroke?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d={icons[name]} />
</svg>
