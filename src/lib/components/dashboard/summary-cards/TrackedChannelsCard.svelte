<script lang="ts">
	import { Card, CardHeader, CardTitle } from '$lib/components/ui/card';

	let { trackedChannels }: { trackedChannels: number } = $props();
</script>

<Card class="bg-card/80">
	<CardHeader class="gap-2">
		<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Tracked Channels</p>
		<CardTitle class="text-2xl">{trackedChannels}</CardTitle>
	</CardHeader>
</Card>
