<script lang="ts">
	import MostActiveStreamersCard from './MostActiveStreamersCard.svelte';
	import RecentEventsCard from './RecentEventsCard.svelte';
	import type { ChannelPointsRecentEventItem, StreamerActivityItem } from '../shared/types';

	let {
		streamers = [],
		events = [],
		days = 7
	}: {
		streamers: StreamerActivityItem[];
		events?: ChannelPointsRecentEventItem[];
		days?: number;
	} = $props();
</script>

<section class="grid gap-4 md:grid-cols-2">
	<RecentEventsCard {events} />

	<MostActiveStreamersCard {streamers} {days} />
</section>
