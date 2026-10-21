<script lang="ts">
	// The switch of Orca's settings rows (its SettingsSwitch), for boolean settings.
	let { checked, label, disabled = false, onchange }: { checked: boolean; label: string; disabled?: boolean; onchange: (checked: boolean) => void } = $props();
</script>

<button
	role="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	class={['relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50', checked ? 'bg-(--vscode-foreground)' : 'bg-(--vscode-descriptionForeground)/30']}
	onclick={() => onchange(!checked)}
>
	<span class={['pointer-events-none block size-3.5 rounded-full bg-(--vscode-editor-background) shadow-sm transition-transform', checked && 'translate-x-4']}></span>
</button>
