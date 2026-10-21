<script lang="ts" generics="T extends string">
	// Orca's segmented control (its SettingsSegmentedControl): Enabled / Disabled, Manual / Yolo, ….
	let {
		value,
		options,
		label,
		size = 'sm',
		onchange
	}: { value: T; options: readonly { value: T; label: string; title?: string }[]; label: string; size?: 'sm' | 'md'; onchange: (value: T) => void } = $props();
</script>

<div role="radiogroup" aria-label={label} class="inline-flex items-center rounded-md border border-(--vscode-widget-border) bg-(--vscode-editor-background)/50 p-0.5">
	{#each options as o (o.value)}
		{@const on = o.value === value}
		<button
			type="button"
			role="radio"
			aria-checked={on}
			title={o.title}
			class={[
				'rounded-sm text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--vscode-focusBorder)/50',
				size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm',
				on ? 'bg-(--vscode-list-inactiveSelectionBackground) font-medium text-(--vscode-foreground)' : 'text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)'
			]}
			onclick={() => !on && onchange(o.value)}>{o.label}</button
		>
	{/each}
</div>
