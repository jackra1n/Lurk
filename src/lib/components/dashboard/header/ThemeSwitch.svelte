<script lang="ts">
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import { Button } from '$lib/components/ui/button';

	let {
		isDark,
		onToggle
	}: {
		isDark: boolean;
		onToggle: () => void;
	} = $props();
</script>

<Button type="button" variant="outline" size="sm" onclick={onToggle}>
	{#if isDark}
		<Moon class="size-4" />
	{:else}
		<Sun class="size-4" />
	{/if}
	{isDark ? 'Dark' : 'Light'}
</Button>
