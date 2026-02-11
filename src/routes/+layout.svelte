<script lang="ts">
	let { children } = $props();
	import '../app.css';
	import * as Tooltip from '$lib/components/ui/tooltip';
</script>

<svelte:head>
</svelte:head>

<Tooltip.Provider>
	{@render children()}
</Tooltip.Provider>
