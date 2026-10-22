<script lang="ts" module>
	import arkaiChatUrl from '#lib/assets/icons/arkai-chat.svg';
	import arkaiMarkUrl from '#lib/assets/icons/arkai-mark.svg';

	/** Arkai's marks as image URLs, for an `<img>` (kingu-old shows arkai-mark.svg as the agent's icon). */
	export { arkaiChatUrl, arkaiMarkUrl };
</script>

<script lang="ts">
	// A product icon as VS Code draws it: `<span class="codicon codicon-<id>">`, its glyph the
	// `::before` the active `workbench.productIconTheme` gives the id (codicons.ts). `arkai-chat` and
	// `arkai-mark` are Kingu's masked marks (kingu-old's `.kingu-arkai-chat-icon`).
	import { MASK_ICONS, parseIconId, type IconModifier } from './codicons';

	let {
		id,
		size = 16,
		modifier,
		label,
		title,
		class: cls = ''
	}: {
		/** An icon id (`plus`, `chat-view-icon`, VS Code's `sync~spin` form too), or `arkai-chat` / `arkai-mark`. */
		id: string;
		/** Font size (mask icons: width and height) in px; VS Code's codicons are 16. */
		size?: number;
		/** `spin` (spins `sync`, `loading`, `gear`, as VS Code does) or `disabled` (dimmed). */
		modifier?: IconModifier;
		/** Accessible name: the icon is an image with it; without one it is hidden from screen readers. */
		label?: string;
		/** Tooltip. */
		title?: string;
		class?: string;
	} = $props();

	const parsed = $derived(parseIconId(id));
	const mod = $derived(modifier ?? parsed.modifier);
	const mask = $derived(MASK_ICONS[parsed.id]);
	const classes = $derived(
		[mask ?? `codicon codicon-${parsed.id}`, mod ? `codicon-modifier-${mod}` : '', cls].filter(Boolean).join(' ')
	);
</script>

<span
	class={classes}
	style:font-size={mask ? undefined : `${size}px`}
	style:width={mask ? `${size}px` : undefined}
	style:height={mask ? `${size}px` : undefined}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	{title}
></span>
