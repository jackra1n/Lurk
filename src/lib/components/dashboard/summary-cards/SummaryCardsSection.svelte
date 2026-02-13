<script lang="ts">
	import MinerStatusCard from './MinerStatusCard.svelte';
	import PointsEarnedCard from './PointsEarnedCard.svelte';
	import TrackedChannelsCard from './TrackedChannelsCard.svelte';
	import type { ChannelPointsAnalyticsSummary, MinerStatusResponse } from '../shared/types';

	let {
		minerStatus,
		summary,
		startDisabled = false,
		stopDisabled = false,
		actionPhase = 'idle',
		onStart,
		onStop
	}: {
		minerStatus: MinerStatusResponse;
		summary: ChannelPointsAnalyticsSummary | null;
		startDisabled?: boolean;
		stopDisabled?: boolean;
		actionPhase?: 'idle' | 'starting' | 'stopping';
		onStart?: () => void | Promise<void>;
		onStop?: () => void | Promise<void>;
	} = $props();
</script>

<section class="grid gap-4 md:grid-cols-3">
	<MinerStatusCard
		{minerStatus}
		{startDisabled}
		{stopDisabled}
		{actionPhase}
		{onStart}
		{onStop}
	/>
	<TrackedChannelsCard
		trackedChannels={summary?.trackedChannels ?? minerStatus.configuredStreamers.length}
		liveChannels={minerStatus.streamerRuntimeStates.filter((streamer) => streamer.isOnline).length}
	/>
	<PointsEarnedCard pointsEarned={summary?.pointsEarnedThisSession ?? 0} />
</section>
