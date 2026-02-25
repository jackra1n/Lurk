<script lang="ts">
	import MinerStatusCard from './MinerStatusCard.svelte';
	import MostActiveStreamersCard from './MostActiveStreamersCard.svelte';
	import TrackedChannelsCard from './TrackedChannelsCard.svelte';
	import type { ChannelPointsAnalyticsSummary, MinerStatusResponse, StreamerActivityItem } from '../shared/types';

	let {
		minerStatus,
		summary,
		streamerActivity = [],
		startDisabled = false,
		stopDisabled = false,
		actionPhase = 'idle',
		onStart,
		onStop
	}: {
		minerStatus: MinerStatusResponse;
		summary: ChannelPointsAnalyticsSummary | null;
		streamerActivity?: StreamerActivityItem[];
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
	<MostActiveStreamersCard streamers={streamerActivity} />
</section>
