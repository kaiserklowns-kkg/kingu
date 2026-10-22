<script lang="ts">
	// Settings › Setup: whether this machine can run a first agent task, and one action per gap.
	import { onMount } from 'svelte';
	import Icon from '#lib/workbench/Icon.svelte';
	import { t } from '#lib/i18n/index.ts';
	import { setup } from '#lib/setup/setup.svelte.ts';
	import SetupList from '#lib/setup/SetupList.svelte';

	onMount(() => void setup.check());
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-3xl px-8 pt-10 pb-24">
		<h1 class="flex items-center gap-2 text-2xl leading-tight font-semibold"><Icon name="check" size={20} />{t('setup.title')}</h1>
		<p class="mt-2 max-w-2xl text-sm leading-6 text-(--vscode-descriptionForeground)">{t('setup.hint')}</p>
		<div class="mt-6">
			<SetupList />
		</div>
	</div>
</div>
