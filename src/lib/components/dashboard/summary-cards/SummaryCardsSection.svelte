<script lang="ts">
	import MinerStatusCard from './MinerStatusCard.svelte';
	import PointsEarnedCard from './PointsEarnedCard.svelte';
	import TrackedChannelsCard from './TrackedChannelsCard.svelte';
	import type { ChannelPointsAnalyticsSummary, MinerStatusResponse } from '../shared/types';

	let {
		minerStatus,
		summary
	}: {
		minerStatus: MinerStatusResponse;
		summary: ChannelPointsAnalyticsSummary | null;
	} = $props();
</script>

<section class="grid gap-4 md:grid-cols-3">
	<MinerStatusCard {minerStatus} />
	<TrackedChannelsCard
		trackedChannels={summary?.trackedChannels ?? minerStatus.configuredStreamers.length}
		liveChannels={minerStatus.streamerRuntimeStates.filter((streamer) => streamer.isOnline).length}
	/>
	<PointsEarnedCard pointsEarned={summary?.pointsEarnedThisSession ?? 0} />
</section>
