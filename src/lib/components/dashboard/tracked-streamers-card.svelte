<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';

	let { trackedStreamerCount }: { trackedStreamerCount: number } = $props();
</script>

<Card class="bg-card/80">
	<CardHeader class="flex-row items-center justify-between gap-3">
		<div>
			<CardTitle class="text-lg">Tracked Streamers</CardTitle>
			<CardDescription class="text-sm">Manage channels monitored for points.</CardDescription>
		</div>
		<Badge variant="outline">{trackedStreamerCount} tracked</Badge>
	</CardHeader>
	<CardContent>
		<p class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-6 text-center text-sm text-muted-foreground">
			No streamers tracked.
		</p>
	</CardContent>
</Card>
