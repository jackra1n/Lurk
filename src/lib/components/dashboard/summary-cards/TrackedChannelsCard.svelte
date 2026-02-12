<script lang="ts">
	import { Card, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';

	let { trackedChannels, liveChannels }: { trackedChannels: number; liveChannels: number } = $props();
</script>

<Card class="bg-card/80">
	<CardHeader class="gap-2">
		<p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">Tracked Channels</p>
		<CardTitle class="text-2xl">{trackedChannels}</CardTitle>
		<CardDescription class="text-sm">{liveChannels} live now</CardDescription>
	</CardHeader>
</Card>
