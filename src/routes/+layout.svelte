<script lang="ts">
	let { children } = $props();
	import '../app.css';
</script>

<svelte:head>
</svelte:head>

{@render children()}
