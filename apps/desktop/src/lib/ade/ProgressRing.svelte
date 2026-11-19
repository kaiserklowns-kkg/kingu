<script lang="ts">
	// A program's reported progress as a ring at glyph size (Orca's AgentProgressRing): fills
	// clockwise from 12 o'clock; butt caps so a short arc is not overstated.
	import { clampPercent, ringArc } from './programStatus';

	let { percent, tone = 'working', label, size = 'size-3' }: { percent: number; tone?: 'working' | 'attention'; label: string; size?: string } = $props();
</script>

<svg
	viewBox="0 0 16 16"
	role="progressbar"
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={clampPercent(percent)}
	aria-label={label}
	data-progress-ring
	class={['block shrink-0 -rotate-90', size, tone === 'working' ? 'text-yellow-500' : 'text-violet-400']}
>
	<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
	<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="3" pathLength="100" stroke-dasharray={`${ringArc(percent)} 100`} class="arc" />
</svg>

<style>
	.arc {
		transition: stroke-dasharray 500ms ease-out;
	}
	@media (prefers-reduced-motion: reduce) {
		.arc {
			transition: none;
		}
	}
</style>
