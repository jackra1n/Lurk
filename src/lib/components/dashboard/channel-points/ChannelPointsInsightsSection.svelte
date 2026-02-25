<script lang="ts">
	import MostActiveStreamersCard from '../summary-cards/MostActiveStreamersCard.svelte';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import type { StreamerActivityItem } from '../shared/types';

	let {
		streamers = [],
		days = 7
	}: {
		streamers: StreamerActivityItem[];
		days?: number;
	} = $props();
</script>

<section class="grid gap-4 md:grid-cols-2">
	<Card class="bg-card/80">
		<CardHeader class="gap-3">
			<div class="flex items-center justify-between gap-3">
				<CardTitle class="text-lg">Recent Events</CardTitle>
			</div>
			<CardDescription>
			WIP
			</CardDescription>
		</CardHeader>
		<CardContent>
			<p
				class="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-8 text-center text-sm text-muted-foreground"
			>
				No event feed yet.
			</p>
		</CardContent>
	</Card>

	<MostActiveStreamersCard {streamers} {days} />
</section>
