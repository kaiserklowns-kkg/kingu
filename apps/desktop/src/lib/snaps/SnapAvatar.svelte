<script lang="ts">
	// A snap's tile: its initials on a color picked from its id (snaps have no icons), so a snap
	// looks the same in the side view, the details page and the install confirm.
	import { snapAvatar, type SnapInfo } from './snapModel.ts';

	let { snap, size = 32, muted = false }: { snap: Pick<SnapInfo, 'id' | 'name'>; size?: number; muted?: boolean } = $props();
	const a = $derived(snapAvatar(snap));
</script>

<span
	aria-hidden="true"
	class={['grid shrink-0 place-items-center rounded-md font-semibold text-white select-none', muted && 'opacity-50 grayscale']}
	style:width="{size}px"
	style:height="{size}px"
	style:font-size="{Math.round(size * 0.4)}px"
	style:background="linear-gradient(135deg, hsl({a.hue} 55% 46%), hsl({(a.hue + 40) % 360} 60% 36%))">{a.letters}</span
>
